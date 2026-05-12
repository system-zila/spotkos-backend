require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST", "PUT"]
  }
});

io.on('connection', (socket) => {
  socket.on('join_room', (email) => {
    socket.join(email);
  });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: true // Wajib ditambahkan untuk TiDB Cloud
  }
});

app.get('/api/support/chats', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json([]);
  try {
    const [chats] = await db.query(
      'SELECT id, sender, message as text, DATE_FORMAT(created_at, "%H:%i") as time FROM support_chats WHERE user_email = ? ORDER BY created_at ASC', 
      [email]
    );
    res.json(chats);
  } catch (error) {
    console.error("Support Chat Fetch Error:", error);
    res.status(500).json({ error: 'Gagal mengambil riwayat chat.' });
  }
});

app.post('/api/support/chats', async (req, res) => {
  const { email, sender, message } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO support_chats (user_email, sender, message) VALUES (?, ?, ?)',
      [email, sender, message]
    );

    // Pancarkan sinyal real-time ke semua client yang terhubung
    io.emit('new_support_chat'); 
    
    // CATATAN: Logika INSERT kedua (Bot Auto-reply) DIHAPUS SEPENUHNYA di sini.
    res.json({ success: true, id: result.insertId });
  } catch (error) {
    console.error("Support Chat Insert Error:", error);
    res.status(500).json({ error: 'Gagal mengirim pesan.' });
  }
});

app.get('/api/admin/support/chats', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, user_email, sender, message, DATE_FORMAT(created_at, "%H:%i") as time FROM support_chats ORDER BY created_at ASC');
    
    const groupedChats = rows.reduce((acc, curr) => {
      let group = acc.find(g => g.email === curr.user_email);
      if (!group) {
        group = { email: curr.user_email, messages: [], lastMessage: '' };
        acc.push(group);
      }
      group.messages.push({ id: curr.id, sender: curr.sender, text: curr.message, time: curr.time });
      group.lastMessage = curr.message;
      return acc;
    }, []);

    groupedChats.reverse();
    res.json(groupedChats);
  } catch (error) {
    res.status(500).json({ error: 'Gagal' });
  }
});

app.get('/api/chats/kotak-masuk', async (req, res) => {
  const { email } = req.query;
  try {
    const [messages] = await db.query(
      `SELECT c.*, DATE_FORMAT(c.created_at, "%H:%i") as time, c.created_at as raw_time 
       FROM user_chats c WHERE sender_email = ? OR receiver_email = ? ORDER BY c.created_at ASC`,
      [email, email]
    );

    const conversations = {};
    for (let msg of messages) {
      const otherEmail = msg.sender_email === email ? msg.receiver_email : msg.sender_email;
      if (!conversations[otherEmail]) {
        conversations[otherEmail] = { otherEmail, messages: [], lastMessage: '', time: '', raw_time: '', unread: 0 };
      }
      
      conversations[otherEmail].messages.push({
        id: msg.id,
        text: msg.message,
        sender: msg.sender_email === email ? 'me' : 'them',
        time: msg.time,
        image: msg.image_url
      });
      
      conversations[otherEmail].lastMessage = msg.message; 
      conversations[otherEmail].time = msg.time;
      conversations[otherEmail].raw_time = msg.raw_time;

      if (msg.sender_email === otherEmail && !msg.is_read) {
        conversations[otherEmail].unread += 1;
      }
    }

    const kotakmasukList = [];
    for (let key in conversations) {
      const [userRows] = await db.query('SELECT full_name, avatar FROM users WHERE email = ?', [key]);
      const name = userRows.length > 0 ? userRows[0].full_name : key;
      
      let finalAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=FF6B35&color=fff`;

      if (userRows.length > 0 && userRows[0].avatar) {
        // JIKA AVATAR DIMULAI DENGAN HTTP (Contoh: Google Profile), gunakan langsung.
        if (userRows[0].avatar.startsWith('http')) {
          finalAvatar = userRows[0].avatar;
        } else {
          // JIKA LOKAL, baru tambahkan localhost
          finalAvatar = `http://localhost:5000/${userRows[0].avatar}`;
        }
      }
      
      kotakmasukList.push({
        id: key, 
        email: key,
        name: name,
        avatar: finalAvatar, 
        lastMessage: conversations[key].lastMessage,
        time: conversations[key].time,
        raw_time: conversations[key].raw_time,
        unread: conversations[key].unread,
        messages: conversations[key].messages
      });
    }

    kotakmasukList.sort((a, b) => new Date(b.raw_time) - new Date(a.raw_time));
    res.json(kotakmasukList);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal mengambil kotak masuk' });
  }
});

app.post('/api/chats/send', upload.single('image'), async (req, res) => {
  const { sender, receiver, message } = req.body;
  const imagePath = req.file ? req.file.path.replace(/\\/g, '/') : null;

  try {
    await db.query(
      'INSERT INTO user_chats (sender_email, receiver_email, message, image_url) VALUES (?, ?, ?, ?)', 
      [sender, receiver, message || '', imagePath]
    );

    io.to(receiver).emit('receive_message', {
      sender: sender,
      text: message || '',
      image: imagePath,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    });

    res.json({ success: true });
  } catch (error) { 
    console.error(error);
    res.status(500).json({ error: 'Gagal mengirim pesan' }); 
  }
});

app.put('/api/chats/read', async (req, res) => {
  const { myEmail, otherEmail } = req.body;
  try {
    await db.query('UPDATE user_chats SET is_read = TRUE WHERE receiver_email = ? AND sender_email = ?', [myEmail, otherEmail]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Gagal update status read' }); }
});

app.post('/api/chats/initiate', async (req, res) => {
  const { sender, receiver, message } = req.body;
  try {
    const [existingChat] = await db.query(
      'SELECT id FROM user_chats WHERE (sender_email = ? AND receiver_email = ?) OR (sender_email = ? AND receiver_email = ?) LIMIT 1',
      [sender, receiver, receiver, sender]
    );

    if (existingChat.length === 0) {
      await db.query(
        'INSERT INTO user_chats (sender_email, receiver_email, message) VALUES (?, ?, ?)',
        [sender, receiver, message]
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal memulai obrolan' });
  }
});

app.get('/api/tickets', async (req, res) => {
  try {
    const [tickets] = await db.query('SELECT *, DATE_FORMAT(created_at, "%d %b %Y") as date FROM tickets ORDER BY created_at DESC');
    for (let ticket of tickets) {
      const [replies] = await db.query('SELECT sender_name as sender, message, DATE_FORMAT(created_at, "%d %b %Y") as date FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC', [ticket.id]);
      ticket.userName = ticket.user_name;
      ticket.userEmail = ticket.user_email;
      ticket.replies = replies;
    }
    res.json(tickets);
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/tickets/user', async (req, res) => {
  const { email } = req.query;
  try {
    const [tickets] = await db.query('SELECT *, DATE_FORMAT(created_at, "%d %b %Y") as date FROM tickets WHERE user_email = ? ORDER BY created_at DESC', [email]);
    for (let ticket of tickets) {
      const [replies] = await db.query('SELECT sender_name as sender, message, DATE_FORMAT(created_at, "%d %b %Y") as date FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC', [ticket.id]);
      ticket.replies = replies;
    }
    res.json(tickets);
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/tickets', async (req, res) => {
  const { name, email, subject, message } = req.body;
  const id = `TIK-${Date.now().toString().slice(-6)}`; 
  try {
    await db.query('INSERT INTO tickets (id, user_name, user_email, subject, message) VALUES (?, ?, ?, ?, ?)', [id, name, email, subject, message]);
    res.json({ message: 'Terkirim', id });
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/tickets/:id/reply', async (req, res) => {
  const { id } = req.params;
  const { sender, message } = req.body;
  try {
    await db.query('INSERT INTO ticket_replies (ticket_id, sender_name, message) VALUES (?, ?, ?)', [id, sender, message]);
    await db.query('UPDATE tickets SET status = "in-progress" WHERE id = ? AND status = "open"', [id]);
    res.json({ message: 'Terkirim' });
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/tickets/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db.query('UPDATE tickets SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: 'Sukses' });
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

server.listen(5004, () => console.log('Communication Service berjalan di port 5004 dengan Socket.io'));