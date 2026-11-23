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

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS digital_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_email VARCHAR(100) NOT NULL,
        transaction_id VARCHAR(50) NOT NULL,
        title VARCHAR(100) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        category VARCHAR(50) NOT NULL,
        profit DECIMAL(15,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'paid',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabel digital_transactions siap.');
  } catch (e) { console.error('Gagal membuat tabel:', e.message); }
})();

app.post('/api/payment/create-transaction', async (req, res) => {
  const { name, email, phone, amount, kostName, roomId } = req.body;

  // 1. Sanitasi Matematis Mutlak
  const validAmount = Math.round(Number(amount));
  if (!validAmount || validAmount < 1000) {
    return res.status(400).json({ error: 'Nominal harga tidak valid' });
  }

  // 2. ID Transaksi Unik
  const order_id = `SPOTKOS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // 3. Sanitasi Teks Mutlak (Cegah Error Spasi & Limitasi Karakter Midtrans)
  const safeName = (name || "Customer").substring(0, 25).trim();
  const safeEmail = (email || "user@spotkos.com").replace(/\s/g, '').trim();
  const safeKostName = (kostName || "Kost").substring(0, 30).trim();

  // 4. Struktur Payload dengan ID Dinamis Anda
  const parameter = {
    transaction_details: { 
      order_id: order_id, 
      gross_amount: validAmount 
    },
    customer_details: { 
      first_name: safeName, 
      email: safeEmail, 
      phone: phone || "080000000000" 
    },
    item_details: [{ 
      id: roomId ? `ROOM-${roomId}` : 'KOST-000', // Sesuai logika input Anda
      price: validAmount, 
      quantity: 1, 
      name: `Sewa ${safeKostName}` 
    }]
  };

  try {
    const transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, order_id });
  } catch (error) {
    console.error('Midtrans Error Detail:', error.message);
    res.status(500).json({ error: 'Gagal membuat transaksi Midtrans' });
  }
});

app.post('/api/promos/validate', async (req, res) => {
  const { code, currentTotal, sector } = req.body;
  try {
    const [promos] = await db.query('SELECT * FROM promos WHERE code = ? AND sector = ?', [code, sector]);
    if (promos.length === 0) return res.status(400).json({ error: 'Kode promo tidak valid/salah layanan' });
    
    const promo = promos[0];

    // CEK TANGGAL KEDALUWARSA
    if (new Date(promo.valid_until) < new Date()) {
      return res.status(400).json({ error: 'Kode promo sudah kedaluwarsa' });
    }

    // CEK SYARAT MINIMAL PEMBELIAN
    if (promo.min_purchase > 0 && currentTotal < promo.min_purchase) {
      return res.status(400).json({ error: `Minimal transaksi Rp ${parseInt(promo.min_purchase).toLocaleString('id-ID')} untuk promo ini.` });
    }

    const discount = promo.discount_amount;
    const finalPrice = Math.max(0, currentTotal - discount); 
    res.json({ success: true, discount, finalPrice });
  } catch (error) { res.status(500).json({ error: 'Gagal memvalidasi promo' }); }
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

  if (!email || !booking_id || !amount || !pin) return res.status(400).json({ success: false, message: 'Data tidak lengkap' });

  try {
    const [tenant] = await db.query('SELECT balance, pin FROM users WHERE email = ?', [email]);
    if (tenant.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    if (!tenant[0].pin) return res.status(400).json({ success: false, message: 'Silakan buat PIN transaksi di menu Keamanan Akun.' });
    if (tenant[0].pin !== pin) return res.status(400).json({ success: false, message: 'PIN Transaksi Anda salah!' });
    if (tenant[0].balance < amount) return res.status(400).json({ success: false, message: 'Saldo SpotPay Anda tidak mencukupi.' });

    const [booking] = await db.query(
      'SELECT b.total_price, b.status, b.room_id, b.floor_name, r.owner_email FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?',
      [booking_id]
    );

    if (booking.length === 0) return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan' });
    if (booking[0].status === 'paid') return res.status(400).json({ success: false, message: 'Tagihan sudah lunas' });

    // 1. Potong Saldo Penyewa & Lunaskan Tagihan
    await db.query('UPDATE users SET balance = balance - ? WHERE email = ?', [amount, email]);
    await db.query('UPDATE bookings SET status = "paid" WHERE id = ?', [booking_id]);

    if (booking[0].room_id && booking[0].floor_name) {
      await db.query('UPDATE room_floors SET available_rooms = available_rooms - 1 WHERE room_id = ? AND floor_name = ?', [booking[0].room_id, booking[0].floor_name]);
    }

    // 2. Berikan Keuntungan 90% ke Pemilik (SpotKos Mengambil Komisi 10%)
    if (booking[0].owner_email) {
      const dbTotalPrice = booking[0].total_price;
      const basePrice = Math.round((dbTotalPrice - 25000) / 1.11); // Ekstrak harga dasar tanpa PPN
      const pureIncomeToOwner = basePrice * 0.90; // Pemilik terima 90%
      await db.query('UPDATE users SET balance = balance + ? WHERE email = ?', [pureIncomeToOwner, booking[0].owner_email]);
    }

    res.json({ success: true, message: 'Pembayaran Kos Berhasil!' });
  } catch (error) { res.status(500).json({ success: false, message: 'Gagal memproses pembayaran kos' }); }
});

// --- 1. API BAYAR VIA SALDO SPOTPAY (PULSA, LISTRIK, QRIS) ---
app.post('/api/installments/pay', async (req, res) => {
  const email = req.body.email || req.body.userEmail;
  const bill_id = req.body.bill_id || req.body.billId || 'PLN-TOKEN';
  const amount = req.body.amount;
  const pin = req.body.pin;

  if (!email || !amount || !pin) {
    return res.status(400).json({ success: false, message: 'Data atau PIN tidak lengkap' });
  }

  try {
    const [user] = await db.query('SELECT balance, pin FROM users WHERE email = ?', [email]);
    if (user.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    if (!user[0].pin) return res.status(400).json({ success: false, message: 'Silakan buat PIN transaksi di Profil.' });
    if (user[0].pin !== pin) return res.status(400).json({ success: false, message: 'PIN Transaksi Anda salah!' });
    if (user[0].balance < amount) return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi.' });

    // LOGIKA PENENTUAN KATEGORI (Pulsa, QRIS, atau Listrik)
    let category = 'listrik';
    let title = 'Token Listrik PLN';
    let profit = 2000;

    if (bill_id.startsWith('PULSA')) {
      category = 'pulsa';
      title = 'Pembelian Pulsa';
    } else if (bill_id.startsWith('QRIS')) {
      category = 'qris';
      title = 'Pembayaran Merchant QRIS';
      profit = 500; // Komisi admin dari transaksi QRIS
    }

    let tokenListrik = '';
    if (category === 'listrik') {
       tokenListrik = Array.from({length: 5}, () => Math.floor(1000 + Math.random() * 9000)).join('-');
       title = `Token: ${tokenListrik}`;
    }

    // 1. Potong saldo SpotPay
    await db.query('UPDATE users SET balance = balance - ? WHERE email = ?', [amount, email]);

    // 2. Simpan ke database digital (Agar muncul di Admin & Riwayat SpotPay)
    await db.query(
      'INSERT INTO digital_transactions (user_email, transaction_id, title, amount, category, profit, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [email, bill_id + '-' + Date.now().toString().slice(-4), title, amount, category, profit, 'paid']
    );
    
    res.json({ success: true, message: category === 'listrik' ? title : 'Pembayaran Berhasil' });
  } catch (error) { 
    console.error('SpotPay Error:', error);
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// --- 2. API BAYAR VIA MIDTRANS ---
app.post('/api/digital-transactions/log', async (req, res) => {
  const email = req.body.email || req.body.userEmail || req.body.user_email || 'user@spotkos.com';
  const bill_id = req.body.bill_id || req.body.billId || 'PLN-TOKEN';
  const amount = req.body.amount || 0;
  
  const category = bill_id.startsWith('PULSA') ? 'pulsa' : 'listrik';
  
  let tokenListrik = '';
  let title = category === 'pulsa' ? 'Pembelian Pulsa (Midtrans)' : 'Token Listrik PLN';
  
  if (category === 'listrik') {
     tokenListrik = Array.from({length: 5}, () => Math.floor(1000 + Math.random() * 9000)).join('-');
     title = `Token: ${tokenListrik}`;
  }

  try {
    await db.query('INSERT INTO digital_transactions (user_email, transaction_id, title, amount, category, profit, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [email, bill_id + '-' + Date.now().toString().slice(-4), title, amount, category, 2000, 'paid']);
    res.json({ success: true, message: title }); 
  } catch (error) { 
    console.error('Midtrans Log Error:', error);
    res.status(500).json({ error: 'Gagal mencatat transaksi' }); 
  }
});

app.get('/api/digital-transactions/user', async (req, res) => {
  const { email } = req.query;
  try {
    const [txs] = await db.query('SELECT *, DATE_FORMAT(created_at, "%d %b %Y") as date_label FROM digital_transactions WHERE user_email = ? ORDER BY created_at DESC', [email]);
    res.json(txs);
  } catch (error) { res.status(500).json({ error: 'Gagal mengambil data' }); }
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
  const { status } = req.body;

  try {
    const [result] = await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Data booking tidak ditemukan.' });

    if (status === 'paid') {
      const [bookingInfo] = await db.query(
        `SELECT b.room_id, b.floor_name, b.total_price, r.owner_email 
         FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?`, [id]
      );
      
      if (bookingInfo.length > 0) {
        const bData = bookingInfo[0];
        if (bData.room_id && bData.floor_name) {
          await db.query('UPDATE room_floors SET available_rooms = available_rooms - 1 WHERE room_id = ? AND floor_name = ?', [bData.room_id, bData.floor_name]);
        }
        if (bData.owner_email) {
          const basePrice = Math.round((bData.total_price - 25000) / 1.11);
          const pureIncomeToOwner = basePrice * 0.90; // Potongan Admin 10% via Midtrans
          await db.query('UPDATE users SET balance = balance + ? WHERE email = ?', [pureIncomeToOwner, bData.owner_email]);
        }
      }
    }
    res.json({ message: `Status berhasil diubah menjadi ${status}` });
  } catch (error) { res.status(500).json({ error: 'Gagal mengubah status' }); }
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
        b.id as transaction_id,
        DATE_FORMAT(b.created_at, "%d %b %Y, %H:%i") as datetime,
        b.created_at as raw_date,
        r.name as kost_name,
        r.location as kost_location,
        b.total_price,
        b.total_price as amount,
        b.status,
        u.full_name as user_name,
        u.email as user_email,
        'kos' as category,
        NULL as title
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      JOIN users u ON b.user_email = u.email

      UNION ALL

      SELECT 
        d.transaction_id as invoice_id,
        d.transaction_id as transaction_id,
        DATE_FORMAT(d.created_at, "%d %b %Y, %H:%i") as datetime,
        d.created_at as raw_date,
        NULL as kost_name,
        NULL as kost_location,
        d.amount as total_price,
        d.amount as amount,
        d.status,
        u.full_name as user_name,
        d.user_email as user_email,
        d.category,
        d.title
      FROM digital_transactions d
      LEFT JOIN users u ON d.user_email = u.email

      ORDER BY raw_date DESC
    `);
    
    // Jaring pengaman agar React tidak crash "N.map is not a function"
    res.json(Array.isArray(transactions) ? transactions : []);
  } catch (error) {
    console.error('Get Transactions Error:', error);
    res.json([]); 
  }
});

app.get('/api/admin/promos', async (req, res) => {
  try {
    const [promos] = await db.query('SELECT * FROM promos ORDER BY valid_until DESC');
    res.json(promos);
  } catch (e) { 
    console.error('Promos Error:', e);
    res.json([]); // Jaring pengaman: Kembalikan array kosong agar React tidak "N.map is not a function"
  }
});

app.post('/api/admin/promos', async (req, res) => {
  const { code, discount, sector, min_purchase, valid_until } = req.body;
  try {
    await db.query(
      'INSERT INTO promos (code, discount_amount, sector, min_purchase, valid_until) VALUES (?, ?, ?, ?, ?)', 
      [code, discount, sector, min_purchase || 0, valid_until]
    );
    res.json({ success: true });
  } catch (e) { 
    console.error('Error Add Promo:', e);
    res.status(500).json({ error: 'Gagal membuat promo' }); 
  }
});

app.delete('/api/admin/promos/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM promos WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

setInterval(async () => {
  try {
    await db.query(
      `UPDATE bookings SET status = 'pending' WHERE status = 'paid' AND CURDATE() >= due_date`
    );
    const [expired] = await db.query(
      `SELECT id, room_id, floor_name FROM bookings 
       WHERE status = 'pending' AND CURDATE() > DATE_ADD(due_date, INTERVAL 7 DAY)`
    );
    for (let b of expired) {
      await db.query(`UPDATE bookings SET status = 'failed' WHERE id = ?`, [b.id]);
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