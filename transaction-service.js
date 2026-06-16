require('dotenv').config();
const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

// ✅ FIX NGROK: Bypass interstitial page
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

app.post('/api/payment/create-transaction', async (req, res) => {
  const { name, email, phone, amount, kostName } = req.body;
  const order_id = `SPOTKOS-${Date.now()}`;
  const parameter = {
    transaction_details: { order_id, gross_amount: amount },
    customer_details: { first_name: name, email, phone },
    item_details: [{ id: 'KOST-01', price: amount, quantity: 1, name: `Sewa ${kostName} (1 Bulan)` }]
  };
  try {
    const transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, order_id });
  } catch (error) {
    console.error('Midtrans Error:', error);
    res.status(500).json({ error: 'Gagal membuat transaksi Midtrans' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const userEmail   = req.body.email || req.body.user_email;
  const roomId      = req.body.roomId || req.body.room_id;
  const floorName   = req.body.floorName || req.body.floor_name;
  const checkInDate = req.body.checkInDate || req.body.check_in_date;
  const duration    = parseInt(req.body.duration) || 1;
  const totalPrice  = req.body.totalPrice || req.body.total_price;

  if (!userEmail || !roomId || !checkInDate) {
    return res.status(400).json({ error: 'Data tidak lengkap' });
  }

  // ✅ FIX BUG #6: Validasi floorName wajib ada sebelum cek stok
  if (!floorName) {
    return res.status(400).json({ error: 'Lantai wajib dipilih sebelum booking.' });
  }

  try {
    const [stockCheck] = await db.query(
      'SELECT available_rooms FROM room_floors WHERE room_id = ? AND floor_name = ?',
      [roomId, floorName]
    );

    if (stockCheck.length === 0 || stockCheck[0].available_rooms <= 0) {
      return res.status(400).json({ error: 'Pesanan ditolak: Kamar di lantai ini sudah penuh.' });
    }

    const invoiceId = 'INV-' + Date.now();
    const dueDateObj = new Date(checkInDate);
    dueDateObj.setMonth(dueDateObj.getMonth() + duration);
    const dueDateStr = dueDateObj.toISOString().split('T')[0];

    await db.query(
      `INSERT INTO bookings (id, user_email, room_id, floor_name, check_in_date, duration, total_price, due_date, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [invoiceId, userEmail, roomId, floorName, checkInDate, duration, totalPrice, dueDateStr]
    );

    res.json({ success: true, message: 'Booking berhasil', id: invoiceId });
  } catch (error) {
    console.error('Booking Error:', error);
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
        const dueDate = new Date(b.check_in_date);
        dueDate.setMonth(dueDate.getMonth() + b.duration);
        const cancelDate = new Date(dueDate);
        cancelDate.setDate(cancelDate.getDate() + 3);

        if (now > cancelDate) {
          await db.query('UPDATE bookings SET status = "failed" WHERE id = ?', [b.id]);
          if (b.room_id && b.floor_name) {
            await db.query(
              'UPDATE room_floors SET available_rooms = available_rooms + 1 WHERE room_id = ? AND floor_name = ?',
              [b.room_id, b.floor_name]
            );
          }
        } else if (now >= dueDate && now <= cancelDate) {
          await db.query('UPDATE bookings SET status = "pending" WHERE id = ?', [b.id]);
        }
      }
    }

    const [bookings] = await db.query(`
      SELECT b.id as booking_id, b.room_id as roomId, b.floor_name as floorName,
             DATE_FORMAT(b.created_at, "%d %b %Y") as bookingDate,
             DATE_FORMAT(b.check_in_date, "%d %b %Y") as moveInDate,
             b.status, b.total_price as totalPrice, b.duration,
             r.name as roomName, r.location as roomLocation, r.image as roomImage,
             (SELECT rating FROM reviews WHERE booking_id = b.id LIMIT 1) AS user_rating
      FROM bookings b JOIN rooms r ON b.room_id = r.id
      WHERE b.user_email = ? ORDER BY b.created_at DESC
    `, [email]);

    res.json(bookings);
  } catch (error) {
    console.error('User Bookings Error:', error);
    res.status(500).json({ error: 'Gagal mengambil riwayat booking' });
  }
});

app.post('/api/topup', async (req, res) => {
  const { email, amount } = req.body;

  if (!email || !amount) {
    return res.status(400).json({ success: false, message: 'Email dan nominal wajib diisi.' });
  }

  try {
    const [result] = await db.query(
      'UPDATE users SET balance = balance + ? WHERE email = ?',
      [amount, email]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    res.json({ success: true, message: `Top up Rp ${amount} berhasil!` });
  } catch (error) {
    console.error('Top Up Error:', error);
    res.status(500).json({ success: false, message: 'Gagal melakukan top up server.' });
  }
});

// =========================================================================
// RUTE TRANSAKSI DENGAN PROTEKSI KETAT (PIN)
// =========================================================================

app.post('/api/transfer', async (req, res) => {
  const { sender_email, receiver_identifier, amount, pin } = req.body;

  if (!sender_email || !receiver_identifier || !amount || !pin) {
    return res.status(400).json({ success: false, message: 'Data atau PIN tidak lengkap' });
  }

  try {
    const [sender] = await db.query('SELECT balance, pin FROM users WHERE email = ?', [sender_email]);
    if (sender.length === 0) return res.status(404).json({ success: false, message: 'Akun Anda tidak ditemukan' });

    // Validasi Keamanan PIN
    if (!sender[0].pin) return res.status(400).json({ success: false, message: 'Silakan buat PIN transaksi di menu Keamanan Akun terlebih dahulu.' });
    if (sender[0].pin !== pin) return res.status(400).json({ success: false, message: 'PIN Transaksi Anda salah!' });
    if (sender[0].balance < amount) return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi' });

    const [receiver] = await db.query('SELECT email FROM users WHERE email = ? OR phone = ?', [receiver_identifier, receiver_identifier]);
    if (receiver.length === 0) return res.status(404).json({ success: false, message: 'Pengguna tujuan tidak ditemukan' });
    if (sender_email === receiver[0].email) return res.status(400).json({ success: false, message: 'Tidak bisa transfer ke akun sendiri' });

    await db.query('UPDATE users SET balance = balance - ? WHERE email = ?', [amount, sender_email]);
    await db.query('UPDATE users SET balance = balance + ? WHERE email = ?', [amount, receiver[0].email]);

    res.json({ success: true, message: 'Transfer berhasil!' });
  } catch (error) {
    console.error('Transfer Error:', error);
    res.status(500).json({ success: false, message: 'Gagal memproses transfer' });
  }
});

app.post('/api/pay-kos', async (req, res) => {
  const { email, booking_id, amount, pin } = req.body;

  if (!email || !booking_id || !amount || !pin) {
    return res.status(400).json({ success: false, message: 'Data atau PIN tidak lengkap' });
  }

  try {
    const [tenant] = await db.query('SELECT balance, pin FROM users WHERE email = ?', [email]);
    if (tenant.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    // Validasi Keamanan PIN
    if (!tenant[0].pin) return res.status(400).json({ success: false, message: 'Silakan buat PIN transaksi di menu Keamanan Akun.' });
    if (tenant[0].pin !== pin) return res.status(400).json({ success: false, message: 'PIN Transaksi Anda salah!' });
    if (tenant[0].balance < amount) return res.status(400).json({ success: false, message: 'Saldo SpotPay Anda tidak mencukupi, silakan Top Up.' });

    const [booking] = await db.query(
      'SELECT b.status, b.room_id, b.floor_name, r.owner_email FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?',
      [booking_id]
    );

    if (booking.length === 0) return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan' });
    if (booking[0].status === 'paid') return res.status(400).json({ success: false, message: 'Tagihan sudah lunas' });

    await db.query('UPDATE users SET balance = balance - ? WHERE email = ?', [amount, email]);
    await db.query('UPDATE bookings SET status = "paid" WHERE id = ?', [booking_id]);

    if (booking[0].room_id && booking[0].floor_name) {
      await db.query(
        'UPDATE room_floors SET available_rooms = available_rooms - 1 WHERE room_id = ? AND floor_name = ?',
        [booking[0].room_id, booking[0].floor_name]
      );
    }

    if (booking[0].owner_email) {
      await db.query('UPDATE users SET balance = balance + ? WHERE email = ?', [amount, booking[0].owner_email]);
    }

    res.json({ success: true, message: 'Pembayaran Kos Berhasil!' });
  } catch (error) {
    console.error('Pay Kos Error:', error);
    res.status(500).json({ success: false, message: 'Gagal memproses pembayaran kos' });
  }
});

app.post('/api/installments/pay', async (req, res) => {
  const { email, bill_id, amount, pin } = req.body;

  if (!email || !bill_id || !amount || !pin) {
    return res.status(400).json({ success: false, message: 'Data atau PIN tidak lengkap' });
  }

  try {
    const [user] = await db.query('SELECT balance, pin FROM users WHERE email = ?', [email]);
    if (user.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    // Validasi Keamanan PIN
    if (!user[0].pin) return res.status(400).json({ success: false, message: 'Silakan buat PIN transaksi di menu Keamanan Akun.' });
    if (user[0].pin !== pin) return res.status(400).json({ success: false, message: 'PIN Transaksi Anda salah!' });
    if (user[0].balance < amount) return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi untuk transaksi ini.' });

    await db.query('UPDATE users SET balance = balance - ? WHERE email = ?', [amount, email]);

    res.json({ success: true, message: 'Transaksi Berhasil!' });
  } catch (error) {
    console.error('Installment Error:', error);
    res.status(500).json({ success: false, message: 'Gagal memproses transaksi' });
  }
});

// =========================================================================

app.get('/api/bookings/owner', async (req, res) => {
  const { email } = req.query;
  try {
    const [incomes] = await db.query(`
      SELECT b.id as booking_id, b.room_id as roomId, b.floor_name as floorName,
             DATE_FORMAT(b.created_at, "%d %b %Y") as bookingDate,
             b.status, (b.total_price * b.duration) as totalPrice, b.duration,
             r.name as roomName, u.full_name as tenant_name
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      JOIN users u ON b.user_email = u.email
      WHERE r.owner_email = ? ORDER BY b.created_at DESC
    `, [email]);
    res.json(incomes);
  } catch (error) {
    console.error('Owner Income Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data pemasukan' });
  }
});

app.post('/api/promos/claim', async (req, res) => {
  const { email, promo_code } = req.body;

  if (!email || !promo_code) {
    return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
  }

  const code = promo_code.toUpperCase().trim();
  let bonusAmount = 0;

  if (code === 'SPOTPAY50K') {
    bonusAmount = 50000;
  } else if (code === 'DISKONKOS') {
    bonusAmount = 25000;
  } else {
    return res.status(400).json({ success: false, message: 'Kode promo salah atau sudah melewati batas kuota.' });
  }

  try {
    const [result] = await db.query(
      'UPDATE users SET balance = balance + ? WHERE email = ?',
      [bonusAmount, email]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Akun pengguna gagal diverifikasi.' });
    }

    res.json({ 
      success: true, 
      message: `Selamat! Kode ${code} sukses diklaim. Bonus Rp ${bonusAmount.toLocaleString('id-ID')} telah ditambahkan.` 
    });
  } catch (error) {
    console.error('Promo Claim Error:', error);
    res.status(500).json({ success: false, message: 'Gagal memproses kode promo di server.' });
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
        await db.query(
          'UPDATE room_floors SET available_rooms = available_rooms - 1 WHERE room_id = ? AND floor_name = ?',
          [roomId, floorName]
        );
      }
      const [bookingInfo] = await db.query(
        `SELECT b.duration, r.price, r.owner_email 
         FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?`,
        [id]
      );
      if (bookingInfo.length > 0 && bookingInfo[0].owner_email) {
        const pureIncome = bookingInfo[0].price * bookingInfo[0].duration;
        await db.query(
          'UPDATE users SET balance = balance + ? WHERE email = ?',
          [pureIncome, bookingInfo[0].owner_email]
        );
      }
    }

    res.json({ message: `Status berhasil diubah menjadi ${status}` });
  } catch (error) {
    console.error('Update Booking Status Error:', error);
    res.status(500).json({ error: 'Gagal mengubah status' });
  }
});

app.post('/api/withdrawals', async (req, res) => {
  const { email, amount } = req.body;
  try {
    const [updateRes] = await db.query(
      'UPDATE users SET balance = balance - ? WHERE email = ? AND balance >= ?',
      [amount, email, amount]
    );
    if (updateRes.affectedRows === 0) return res.status(400).json({ error: 'Saldo tidak mencukupi.' });
    await db.query(
      'INSERT INTO withdrawals (user_email, amount, status) VALUES (?, ?, "pending")',
      [email, amount]
    );
    res.json({ success: true, message: 'Berhasil diajukan' });
  } catch (error) {
    console.error('Withdrawal Error:', error);
    res.status(500).json({ error: 'Gagal mengajukan pencairan' });
  }
});

app.get('/api/withdrawals/user', async (req, res) => {
  const { email } = req.query;
  try {
    const [withdrawals] = await db.query(
      'SELECT *, DATE_FORMAT(created_at, "%d %b %Y") as date_label FROM withdrawals WHERE user_email = ? ORDER BY created_at DESC',
      [email]
    );
    res.json(withdrawals);
  } catch (error) {
    console.error('Get User Withdrawals Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data penarikan' });
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const [withdrawals] = await db.query(`
      SELECT w.*, u.full_name, u.bank_name, u.bank_account, u.bank_account_name
      FROM withdrawals w JOIN users u ON w.user_email = u.email
      ORDER BY w.created_at DESC
    `);
    res.json(withdrawals);
  } catch (error) {
    console.error('Get Withdrawals Error:', error);
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
    console.error('Update Withdrawal Status Error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const [transactions] = await db.query(`
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
    `);
    res.json(transactions);
  } catch (error) {
    console.error('Get Transactions Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data transaksi' });
  }
});

setInterval(async () => {
  try {
    await db.query(
      `UPDATE bookings SET status = 'pending' WHERE status = 'paid' AND CURDATE() >= due_date`
    );
    const [expired] = await db.query(
      `SELECT id, room_id, floor_name FROM bookings 
       WHERE status = 'pending' AND CURDATE() > DATE_ADD(due_date, INTERVAL 3 DAY)`
    );
    for (let b of expired) {
      await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`, [b.id]);
      await db.query(
        `UPDATE room_floors SET available_rooms = available_rooms + 1 WHERE room_id = ? AND floor_name = ?`,
        [b.room_id, b.floor_name]
      );
    }
  } catch (error) {
    console.error('Auto-Evaluator Error:', error);
  }
}, 1000 * 60 * 60);

app.listen(5003, () => console.log('✅ Transaction Service berjalan di port 5003'));