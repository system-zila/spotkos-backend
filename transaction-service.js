require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const midtransClient = require('midtrans-client');

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: true // Wajib ditambahkan untuk TiDB Cloud
  }
});

const snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

app.post('/api/payment/create-transaction', async (req, res) => {
  const { name, email, phone, amount, kostName } = req.body;
  const order_id = `SPOTKOS-${Date.now()}`;

  const parameter = {
    transaction_details: { order_id: order_id, gross_amount: amount },
    customer_details: { first_name: name, email: email, phone: phone },
    item_details: [{ id: "KOST-01", price: amount, quantity: 1, name: `Sewa ${kostName} (1 Bulan)` }]
  };

  try {
    const transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, order_id });
  } catch (error) {
    console.error("Midtrans Error:", error);
    res.status(500).json({ error: 'Gagal membuat transaksi Midtrans' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const userEmail = req.body.email || req.body.user_email;
  const roomId = req.body.roomId || req.body.room_id;
  const floorName = req.body.floorName || req.body.floor_name;
  const checkInDate = req.body.checkInDate || req.body.check_in_date;
  const duration = parseInt(req.body.duration) || 1;
  const totalPrice = req.body.totalPrice || req.body.total_price;

  if (!userEmail || !roomId || !checkInDate) return res.status(400).json({ error: 'Data tidak lengkap' });

  try {
    // =========================================================
    // VALIDASI STOK: Cek ke database sebelum membuat pesanan
    // =========================================================
    const [stockCheck] = await db.query(
      'SELECT available_rooms FROM room_floors WHERE room_id = ? AND floor_name = ?', 
      [roomId, floorName]
    );

    // Tolak jika data lantai tidak ditemukan atau kuota sudah habis (<= 0)
    if (stockCheck.length === 0 || stockCheck[0].available_rooms <= 0) {
      return res.status(400).json({ error: 'Pesanan ditolak: Kamar di lantai ini sudah penuh.' });
    }
    // =========================================================

    const invoiceId = 'INV-' + Date.now();
    const dueDateObj = new Date(checkInDate);
    dueDateObj.setMonth(dueDateObj.getMonth() + duration);
    const dueDateStr = dueDateObj.toISOString().split('T')[0]; 

    const query = `
      INSERT INTO bookings (id, user_email, room_id, floor_name, check_in_date, duration, total_price, due_date, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `;

    await db.query(query, [invoiceId, userEmail, roomId, floorName, checkInDate, duration, totalPrice, dueDateStr]);

    res.json({ success: true, message: 'Booking berhasil', id: invoiceId });
  } catch (error) {
    console.error("Booking Error:", error);
    res.status(500).json({ error: 'Gagal membuat pesanan' });
  }
});

app.get('/api/bookings/user', async (req, res) => {
  const { email } = req.query;
  try {
    const [rawBookings] = await db.query('SELECT * FROM bookings WHERE user_email = ?', [email]);
    const now = new Date();

    for (let b of rawBookings) {
      if (b.status === 'paid') {
        const checkInDate = new Date(b.check_in_date);
        const dueDate = new Date(checkInDate);
        dueDate.setMonth(dueDate.getMonth() + b.duration);

        const cancelDate = new Date(dueDate);
        cancelDate.setDate(cancelDate.getDate() + 3);

        if (now > cancelDate) {
          await db.query('UPDATE bookings SET status = "failed" WHERE id = ?', [b.id]);
          if (b.room_id && b.floor_name) {
            await db.query('UPDATE room_floors SET available_rooms = available_rooms + 1 WHERE room_id = ? AND floor_name = ?', [b.room_id, b.floor_name]);
          }
        } else if (now >= dueDate && now <= cancelDate) {
          await db.query('UPDATE bookings SET status = "pending" WHERE id = ?', [b.id]);
        }
      }
    }

    const query = `
      SELECT b.id as booking_id, b.room_id as roomId, b.floor_name as floorName, 
             DATE_FORMAT(b.created_at, "%d %b %Y") as bookingDate, 
             DATE_FORMAT(b.check_in_date, "%d %b %Y") as moveInDate, 
             b.status, b.total_price as totalPrice, b.duration, r.name as roomName, 
             r.location as roomLocation, r.image as roomImage
      FROM bookings b JOIN rooms r ON b.room_id = r.id
      WHERE b.user_email = ? ORDER BY b.created_at DESC
    `;
    const [bookings] = await db.query(query, [email]);
    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal mengambil riwayat booking' });
  }
});

app.put('/api/bookings/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, roomId, floorName } = req.body; 

  try {
    const [result] = await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Data booking tidak ditemukan.' });

    if (status === 'paid') {
      if (roomId && floorName) {
        await db.query('UPDATE room_floors SET available_rooms = available_rooms - 1 WHERE room_id = ? AND floor_name = ?', [roomId, floorName]);
      }
      
      const [bookingInfo] = await db.query('SELECT b.duration, r.price, r.owner_email FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?', [id]);
      
      if (bookingInfo.length > 0 && bookingInfo[0].owner_email) {
        const pureIncome = bookingInfo[0].price * bookingInfo[0].duration; 
        await db.query('UPDATE users SET balance = balance + ? WHERE email = ?', [pureIncome, bookingInfo[0].owner_email]);
      }
    }
    
    res.json({ message: `Status berhasil diubah menjadi ${status}` });
  } catch (error) {
    console.error("Database Status Update Error:", error);
    res.status(500).json({ error: 'Gagal mengubah status' });
  }
});

app.post('/api/withdrawals', async (req, res) => {
  const { email, amount } = req.body;
  try {
    const [updateRes] = await db.query('UPDATE users SET balance = balance - ? WHERE email = ? AND balance >= ?', [amount, email, amount]);
    if (updateRes.affectedRows === 0) {
      return res.status(400).json({ error: 'Saldo tidak mencukupi.' });
    }
    await db.query('INSERT INTO withdrawals (user_email, amount, status) VALUES (?, ?, "pending")', [email, amount]);
    res.json({ success: true, message: 'Berhasil diajukan' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengajukan pencairan' });
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const [withdrawals] = await db.query(`
      SELECT w.*, u.full_name, u.bank_name, u.bank_account, u.bank_account_name 
      FROM withdrawals w 
      JOIN users u ON w.user_email = u.email 
      ORDER BY w.created_at DESC
    `);
    res.json(withdrawals);
  } catch (error) {
    console.error("Gagal mengambil data withdrawal:", error);
    res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
});

app.put('/api/admin/withdrawals/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; 

  try {
    const [wd] = await db.query('SELECT * FROM withdrawals WHERE id = ?', [id]);
    if (wd.length === 0) return res.status(404).json({ error: 'Data tidak ditemukan' });

    await db.query('UPDATE withdrawals SET status = ? WHERE id = ?', [status, id]);

    if (status === 'rejected') {
      await db.query('UPDATE users SET balance = balance + ? WHERE email = ?', [wd[0].amount, wd[0].user_email]);
    }
    res.json({ message: `Penarikan saldo berhasil di-${status}` });
  } catch (error) {
    console.error("Gagal update status withdrawal:", error);
    res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const query = `
      SELECT 
        b.id as invoice_id,
        DATE_FORMAT(b.created_at, "%d %b %Y, %H:%i") as datetime,
        b.created_at as raw_date, 
        r.name as kost_name,
        r.location as kost_location,
        b.total_price,
        b.status,
        u.full_name as user_name,
        u.email as user_email
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      JOIN users u ON b.user_email = u.email
      ORDER BY b.created_at DESC
    `;
    const [transactions] = await db.query(query);
    res.json(transactions);
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ error: 'Gagal mengambil data transaksi' });
  }
});

setInterval(async () => {
  try {
    await db.query(`UPDATE bookings SET status = 'pending' WHERE status = 'paid' AND CURDATE() >= due_date`);
    const [expired] = await db.query(`SELECT id, room_id, floor_name FROM bookings WHERE status = 'pending' AND CURDATE() > DATE_ADD(due_date, INTERVAL 3 DAY)`);
    for (let b of expired) {
      await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`, [b.id]);
      await db.query(`UPDATE room_floors SET available_rooms = available_rooms + 1 WHERE room_id = ? AND floor_name = ?`, [b.room_id, b.floor_name]);
    }
  } catch (error) {
    console.error("Auto-Evaluator Error:", error);
  }
}, 1000 * 60 * 60);

app.listen(5003, () => console.log('Transaction Service berjalan di port 5003'));