require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();

// ✅ FIX: Daftarkan allowed origins dari .env
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ✅ FIX NGROK: Tambahkan header bypass di semua response
// Ini penting karena request dari Vercel ke ngrok akan kena interstitial page
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true, // GANTI allowedOrigins menjadi true
    methods: ['GET', 'POST', 'PUT']
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

function buildAvatarUrl(avatarValue, name) {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'User')}&background=FF6B35&color=fff`;
  if (!avatarValue) return fallback;
  if (avatarValue.startsWith('http://') || avatarValue.startsWith('https://')) {
    return avatarValue;
  }
  const base = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${base}/${avatarValue}`;
}

// =========================================================================
// SUPPORT CHAT
// =========================================================================
app.get('/api/support/chats', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json([]);
  try {
    const [chats] = await db.query(
      `SELECT id, sender, message as text, DATE_FORMAT(created_at, "%H:%i") as time 
       FROM support_chats WHERE user_email = ? ORDER BY created_at ASC`,
      [email]
    );
    res.json(chats);
  } catch (error) {
    console.error('Support Chat Fetch Error:', error);
    res.status(500).json({ error: 'Gagal mengambil riwayat chat.' });
  }
});

app.post('/api/support/chats', async (req, res) => {
  const { email, sender, message } = req.body;
  try {
    let shouldReplyBot = false;

    // 1. Cek jejak waktu murni dari sisi Database untuk mencegah Bug Timezone
    if (sender === 'user') {
      const [lastChats] = await db.query(
        `SELECT TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS diff_mins 
         FROM support_chats 
         WHERE user_email = ? AND sender = 'user' 
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      );

      // Jika belum pernah chat sama sekali
      if (lastChats.length === 0) {
        shouldReplyBot = true;
      } else {
        // Tarik selisih menit langsung dari hasil perhitungan database
        const diffMinutes = lastChats[0].diff_mins;
        if (diffMinutes >= 30) {
          shouldReplyBot = true;
        }
      }
    }

    // 2. Simpan pesan asli dari user ke database
    const [result] = await db.query(
      'INSERT INTO support_chats (user_email, sender, message) VALUES (?, ?, ?)',
      [email, sender, message]
    );

    // 3. Suntikkan pesan bot ke database SEBELUM socket.io menembakkan sinyal
    if (shouldReplyBot) {
      const botMessage = "Halo! 👋 Terima kasih telah menghubungi Support SpotKos. Pesan Anda sudah kami terima. Tim Admin kami sedang mengeceknya dan akan membalas dalam beberapa saat lagi.";
      await db.query(
        'INSERT INTO support_chats (user_email, sender, message) VALUES (?, ?, ?)',
        [email, 'admin', botMessage] // Dilabeli sebagai admin agar frontend menampilkannya sebagai balasan
      );
    }

    // 4. Trigger Socket.io (Mempertahankan kode asli Anda)
    io.emit('new_support_chat');
    
    // 5. Kembalikan response (Mempertahankan kode asli Anda)
    res.json({ success: true, id: result.insertId });
  } catch (error) {
    console.error('Support Chat Insert Error:', error);
    res.status(500).json({ error: 'Gagal mengirim pesan.' });
  }
});

app.get('/api/admin/support/chats', async (req, res) => {
  try {
    // 1. Tarik u.full_name dan u.avatar menggunakan LEFT JOIN
    const [rows] = await db.query(
      `SELECT sc.id, sc.user_email, sc.sender, sc.message, DATE_FORMAT(sc.created_at, "%H:%i") as time,
              u.full_name, u.avatar
       FROM support_chats sc
       LEFT JOIN users u ON sc.user_email = u.email 
       ORDER BY sc.created_at ASC`
    );
    
    const groupedChats = rows.reduce((acc, curr) => {
      let group = acc.find(g => g.email === curr.user_email);
      if (!group) {
        // 2. Masukkan name dan avatar ke dalam objek respons
        group = { 
          email: curr.user_email, 
          name: curr.full_name || curr.user_email.split('@')[0],
          avatar: curr.avatar || null,
          messages: [], 
          lastMessage: '' 
        };
        acc.push(group);
      }
      group.messages.push({ id: curr.id, sender: curr.sender, text: curr.message, time: curr.time });
      group.lastMessage = curr.message;
      return acc;
    }, []);
    
    groupedChats.reverse();
    res.json(groupedChats);
  } catch (error) {
    console.error('Admin Support Chats Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data' });
  }
});
// =========================================================================
// USER CHATS (KOTAK MASUK)
// =========================================================================
app.get('/api/chats/kotak-masuk', async (req, res) => {
  const { email } = req.query;
  try {
    const [messages] = await db.query(
      `SELECT c.*, DATE_FORMAT(c.created_at, "%H:%i") as time, c.created_at as raw_time 
       FROM user_chats c 
       WHERE sender_email = ? OR receiver_email = ? 
       ORDER BY c.created_at ASC`,
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
      const rawAvatar = userRows.length > 0 ? userRows[0].avatar : null;
      const avatarUrl = buildAvatarUrl(rawAvatar, name);

      kotakmasukList.push({
        id: key,
        email: key,
        name,
        avatar: avatarUrl,
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
    console.error('Kotak Masuk Error:', error);
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
      sender,
      text: message || '',
      image: imagePath,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Send Chat Error:', error);
    res.status(500).json({ error: 'Gagal mengirim pesan' });
  }
});

app.put('/api/chats/read', async (req, res) => {
  const { myEmail, otherEmail } = req.body;
  try {
    await db.query(
      'UPDATE user_chats SET is_read = TRUE WHERE receiver_email = ? AND sender_email = ?',
      [myEmail, otherEmail]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update status read' });
  }
});

app.post('/api/chats/initiate', async (req, res) => {
  const { sender, receiver, message } = req.body;
  try {
    const [existingChat] = await db.query(
      `SELECT id FROM user_chats 
       WHERE (sender_email = ? AND receiver_email = ?) OR (sender_email = ? AND receiver_email = ?) 
       LIMIT 1`,
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
    console.error('Initiate Chat Error:', error);
    res.status(500).json({ error: 'Gagal memulai obrolan' });
  }
});

// =========================================================================
// TICKETS
// =========================================================================
app.get('/api/tickets', async (req, res) => {
  try {
    const [tickets] = await db.query(
      `SELECT *, DATE_FORMAT(created_at, "%d %b %Y") as date 
       FROM tickets ORDER BY created_at DESC`
    );
    for (let ticket of tickets) {
      const [replies] = await db.query(
        `SELECT sender_name as sender, message, DATE_FORMAT(created_at, "%d %b %Y") as date 
         FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC`,
        [ticket.id]
      );
      ticket.userName = ticket.user_name;
      ticket.userEmail = ticket.user_email;
      ticket.replies = replies;
    }
    res.json(tickets);
  } catch (error) {
    console.error('Get Tickets Error:', error);
    res.status(500).json({ error: 'Gagal mengambil tiket' });
  }
});

app.get('/api/tickets/user', async (req, res) => {
  const { email } = req.query;
  try {
    const [tickets] = await db.query(
      `SELECT *, DATE_FORMAT(created_at, "%d %b %Y") as date 
       FROM tickets WHERE user_email = ? ORDER BY created_at DESC`,
      [email]
    );
    for (let ticket of tickets) {
      const [replies] = await db.query(
        `SELECT sender_name as sender, message, DATE_FORMAT(created_at, "%d %b %Y") as date 
         FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC`,
        [ticket.id]
      );
      ticket.replies = replies;
    }
    res.json(tickets);
  } catch (error) {
    console.error('Get User Tickets Error:', error);
    res.status(500).json({ error: 'Gagal mengambil tiket' });
  }
});

app.post('/api/tickets', async (req, res) => {
  const { name, email, subject, message } = req.body;
  const id = `TIK-${Date.now().toString().slice(-6)}`;
  try {
    await db.query(
      'INSERT INTO tickets (id, user_name, user_email, subject, message) VALUES (?, ?, ?, ?, ?)',
      [id, name, email, subject, message]
    );
    res.json({ message: 'Terkirim', id });
  } catch (error) {
    console.error('Create Ticket Error:', error);
    res.status(500).json({ error: 'Gagal membuat tiket' });
  }
});

app.post('/api/tickets/:id/reply', async (req, res) => {
  const { id } = req.params;
  const { sender, message } = req.body;
  try {
    await db.query(
      'INSERT INTO ticket_replies (ticket_id, sender_name, message) VALUES (?, ?, ?)',
      [id, sender, message]
    );
    await db.query(
      'UPDATE tickets SET status = "in-progress" WHERE id = ? AND status = "open"',
      [id]
    );
    res.json({ message: 'Terkirim' });
  } catch (error) {
    console.error('Reply Ticket Error:', error);
    res.status(500).json({ error: 'Gagal membalas tiket' });
  }
});

app.put('/api/tickets/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db.query('UPDATE tickets SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: 'Sukses' });
  } catch (error) {
    console.error('Update Ticket Status Error:', error);
    res.status(500).json({ error: 'Gagal update status tiket' });
  }
});

server.listen(5004, () => console.log('✅ Communication Service berjalan di port 5004 dengan Socket.io'));
