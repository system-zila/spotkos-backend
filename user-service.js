require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use('/uploads', express.static('uploads')); // Akses folder foto profil/KTP

// Konfigurasi Google Auth
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Konfigurasi Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Koneksi Database
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

// =========================================================================
// 1. INTEGRASI GOOGLE LOGIN
// =========================================================================
app.post('/api/google-login', async (req, res) => {
  const { token } = req.body;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { email, name, picture } = ticket.getPayload();

    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    
    if (users.length === 0) {
      await db.query(
        'INSERT INTO users (full_name, email, password, role, avatar, notif_email, notif_sms, notif_promo, notif_reminder) VALUES (?, ?, "", "user", ?, 1, 0, 0, 1)', 
        [name, email, picture]
      );
      // PERBAIKAN: Tambahkan avatar: picture
      return res.json({ message: 'Registrasi Google berhasil', user: { name, email, role: 'user', avatar: picture } }); 
    }

    if (users[0].status === 'suspended') {
      return res.status(403).json({ error: 'Akses Ditolak: Akun Anda telah dibekukan oleh Admin.' });
    }

    res.json({ message: 'Login Google berhasil', user: { name: users[0].full_name, email, role: users[0].role, avatar: users[0].avatar } });
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(401).json({ error: 'Verifikasi Token Google gagal di sisi server.' });
  }
});

// =========================================================================
// 2. KODE ASLI SPOTKOS: AUTENTIKASI REGULER
// =========================================================================
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const [existing] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    }
    
    await db.query(
      'INSERT INTO users (full_name, email, password, role, notif_email, notif_sms, notif_promo, notif_reminder) VALUES (?, ?, ?, "user", 1, 0, 0, 1)',
      [name, email, password]
    );
    res.json({ message: 'Registrasi berhasil', user: { name, email, role: 'user' } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal melakukan registrasi' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    if (users[0].status === 'suspended') {
      return res.status(403).json({ error: 'Akses Ditolak: Akun Anda telah dibekukan oleh Admin.' });
    }
    
    res.json({
      message: 'Login berhasil',
      user: {
        name: users[0].full_name,
        email: users[0].email,
        role: users[0].role,
        avatar: users[0].avatar
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal melakukan login' });
  }
});

// =========================================================================
// 3. KODE ASLI SPOTKOS: MANAJEMEN PROFIL USER
// =========================================================================
app.get('/api/users/profile', async (req, res) => {
  const { email } = req.query;
  try {
    const [users] = await db.query('SELECT full_name as name, nickname, email, phone, gender, birth_info, owner_status, avatar, bank_name, bank_account, bank_account_name, balance FROM users WHERE email = ?', [email]);
    if (users.length > 0) res.json(users[0]);
    else res.status(404).json({ error: 'User tidak ditemukan' });
  } catch (error) { res.status(500).json({ error: 'Gagal mengambil profil' }); }
});

app.put('/api/users/update-avatar', upload.single('avatar'), async (req, res) => {
  const { email } = req.body;
  const avatarPath = req.file ? req.file.path.replace(/\\/g, '/') : null;
  try {
    await db.query('UPDATE users SET avatar = ? WHERE email = ?', [avatarPath, email]);
    res.json({ avatarUrl: avatarPath });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengunggah foto profil' });
  }
});

app.put('/api/users/verify-owner', upload.fields([{ name: 'ktp' }, { name: 'selfie' }]), async (req, res) => {
  const { email } = req.body;
  const ktpPath = req.files['ktp'] ? req.files['ktp'][0].path.replace(/\\/g, '/') : null;
  const selfiePath = req.files['selfie'] ? req.files['selfie'][0].path.replace(/\\/g, '/') : null;

  try {
    await db.query(
      'UPDATE users SET ktp_image = ?, selfie_image = ?, owner_status = "pending" WHERE email = ?',
      [ktpPath, selfiePath, email]
    );
    res.json({ message: 'Pengajuan verifikasi berhasil dikirim.' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengajukan verifikasi.' });
  }
});

app.put('/api/users/update-phone', async (req, res) => {
  const { email, phone } = req.body;
  try {
    const [result] = await db.query('UPDATE users SET phone = ? WHERE email = ?', [phone, email]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    res.json({ message: 'Nomor telepon berhasil diperbarui' });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ error: 'Gagal memperbarui nomor telepon' });
  }
});

app.put('/api/users/update-profile', async (req, res) => {
  const { email, field, value } = req.body;
  const columnMap = {
    'name': 'full_name', 'nickname': 'nickname', 'gender': 'gender', 'birth_info': 'birth_info',
    'address': 'address', 'bank_name': 'bank_name', 'bank_account': 'bank_account', 'bank_account_name': 'bank_account_name'  
  };
  const dbColumn = columnMap[field];
  if (!dbColumn) return res.status(400).json({ error: 'Field tidak valid' });

  try {
    await db.query(`UPDATE users SET ${dbColumn} = ? WHERE email = ?`, [value, email]);
    res.json({ message: 'Profil berhasil diperbarui' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal memperbarui profil' });
  }
});

app.put('/api/users/change-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'Email dan password baru wajib diisi' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

  try {
    const [result] = await db.query('UPDATE users SET password = ? WHERE email = ?', [newPassword, email]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    res.json({ message: 'Password berhasil diubah' });
  } catch (error) {
    console.error("Gagal mengubah password:", error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server' });
  }
});

// =========================================================================
// 4. KODE ASLI SPOTKOS: MANAJEMEN ADMIN
// =========================================================================
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, full_name as name, email, phone, role, created_at as joinDate, status FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/users/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; 

  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });

  try {
    const [result] = await db.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    res.json({ message: `Status pengguna berhasil diubah menjadi ${status}.` });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ error: 'Gagal mengubah status pengguna.' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [email]);
    if (users.length === 0) return res.status(401).json({ error: 'Bukan admin.' });
    if (password !== users[0].password) return res.status(401).json({ error: 'Sandi salah.' });
    res.json({ message: 'Sukses' });
  } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/verifications', async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT full_name as name, email, phone, ktp_image, selfie_image, owner_status as status FROM users WHERE owner_status != "unverified"'
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil data verifikasi' });
  }
});

app.put('/api/admin/verifications/action', async (req, res) => {
  const { email, action } = req.body;
  try {
    await db.query('UPDATE users SET owner_status = ? WHERE email = ?', [action, email]);
    res.json({ message: `Status berhasil diubah menjadi ${action}` });
  } catch (error) {
    res.status(500).json({ error: 'Gagal memproses verifikasi' });
  }
});

// Menjalankan User Service di Port 5001
app.listen(5001, () => {
  console.log('User Service berjalan di Port 5001');
});