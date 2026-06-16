require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// ✅ FIX NGROK: Bypass interstitial page untuk semua response dari service ini
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const googleClient = new OAuth2Client();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

function buildAvatarUrl(avatarValue) {
  if (!avatarValue) return null;
  if (avatarValue.startsWith('http://') || avatarValue.startsWith('https://')) {
    return avatarValue;
  }
  const base = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${base}/${avatarValue}`;
}

// =========================================================================
// 1. GOOGLE LOGIN
// =========================================================================
app.post('/api/google-login', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Google tidak ditemukan.' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error: 'Token Google tidak valid.' });

    const { email, name, picture } = payload;
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      await db.query(
        `INSERT INTO users 
          (full_name, email, password, role, avatar, notif_email, notif_sms, notif_promo, notif_reminder) 
         VALUES (?, ?, "", "user", ?, 1, 0, 0, 1)`,
        [name, email, picture]
      );
      return res.json({
        message: 'Registrasi Google berhasil',
        user: { name, email, role: 'user', avatar: picture }
      });
    }

    if (users[0].status === 'suspended') {
      return res.status(403).json({ error: 'Akses Ditolak: Akun Anda telah dibekukan oleh Admin.' });
    }

    const avatarUrl = buildAvatarUrl(users[0].avatar) || picture;
    res.json({
      message: 'Login Google berhasil',
      user: { name: users[0].full_name, email, role: users[0].role, avatar: avatarUrl }
    });
  } catch (error) {
    console.error('Google Auth Error:', error.message);
    if (error.message && error.message.includes('Token used too late')) {
      return res.status(401).json({ error: 'Token Google kedaluwarsa. Silakan login ulang.' });
    }
    if (error.message && error.message.includes('Invalid token')) {
      return res.status(401).json({ error: 'Token Google tidak valid. Pastikan GOOGLE_CLIENT_ID di .env sudah benar.' });
    }
    res.status(401).json({ error: 'Verifikasi Token Google gagal di sisi server.' });
  }
});

// =========================================================================
// 2. AUTENTIKASI REGULER
// =========================================================================
app.post('/api/register', async (req, res) => {
  // Support both field names: Android sends 'full_name' & 'phone', web might send 'name'
  const full_name = req.body.full_name || req.body.name;
  const { email, password, phone, pin } = req.body;

  if (!full_name) return res.status(400).json({ error: 'Nama lengkap wajib diisi.' });

  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(400).json({ error: 'Email sudah terdaftar.' });

    await db.query(
      `INSERT INTO users (full_name, email, password, phone, role, notif_email, notif_sms, notif_promo, notif_reminder) 
       VALUES (?, ?, ?, ?, "user", 1, 0, 0, 1)`,
      [full_name, email, password, phone || null]
    );
    res.json({ message: 'Registrasi berhasil', user: { name: full_name, email, role: 'user' } });
  } catch (error) {
    console.error('Register Error:', error);
    res.status(500).json({ error: 'Gagal melakukan registrasi' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ? AND password = ?',
      [email, password]
    );
    if (users.length === 0) return res.status(401).json({ error: 'Email atau password salah.' });
    if (users[0].status === 'suspended') {
      return res.status(403).json({ error: 'Akses Ditolak: Akun Anda telah dibekukan oleh Admin.' });
    }
    const avatarUrl = buildAvatarUrl(users[0].avatar);
    res.json({
      message: 'Login berhasil',
      user: { name: users[0].full_name, email: users[0].email, role: users[0].role, avatar: avatarUrl }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Gagal melakukan login' });
  }
});

app.get('/api/users/profile', async (req, res) => {
  const { email } = req.query;
  try {
    // FIX: Tambahkan pengecekan has_pin
    const [users] = await db.query(
      'SELECT full_name as name, email, phone, nickname, gender, birth_info, avatar, balance, IF(pin IS NOT NULL AND pin != "", true, false) as has_pin FROM users WHERE email = ?',
      [email]
    );
    if (users.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
    
    // Ubah 1/0 dari MySQL boolean menjadi true/false JavaScript
    users[0].has_pin = !!users[0].has_pin; 
    res.json(users[0]);
  } catch (error) {
    console.error('Get Profile Error:', error);
    res.status(500).json({ error: 'Gagal mengambil profil' });
  }
});

app.put('/api/users/update-avatar', upload.single('avatar'), async (req, res) => {
  const { email } = req.body;
  const avatarPath = req.file ? req.file.path.replace(/\\/g, '/') : null;
  if (!avatarPath) return res.status(400).json({ error: 'File avatar tidak ditemukan.' });
  try {
    await db.query('UPDATE users SET avatar = ? WHERE email = ?', [avatarPath, email]);
    res.json({ avatarUrl: buildAvatarUrl(avatarPath) });
  } catch (error) {
    console.error('Avatar Error:', error);
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
    console.error('Verify Owner Error:', error);
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
    console.error('Update Phone Error:', error);
    res.status(500).json({ error: 'Gagal memperbarui nomor telepon' });
  }
});

app.put('/api/users/update-profile', async (req, res) => {
  const { email, field, value } = req.body;
  const columnMap = {
    name: 'full_name', nickname: 'nickname', gender: 'gender',
    birth_info: 'birth_info', address: 'address',
    bank_name: 'bank_name', bank_account: 'bank_account', bank_account_name: 'bank_account_name'
  };
  const dbColumn = columnMap[field];
  if (!dbColumn) return res.status(400).json({ error: 'Field tidak valid' });
  try {
    await db.query(`UPDATE users SET ${dbColumn} = ? WHERE email = ?`, [value, email]);
    res.json({ message: 'Profil berhasil diperbarui' });
  } catch (error) {
    console.error('Update Profile Error:', error);
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
    console.error('Change Password Error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server' });
  }
});

app.put('/api/users/change-pin', async (req, res) => {
  const { email, old_pin, new_pin } = req.body;
  if (!email || !new_pin) return res.status(400).json({ success: false, message: 'Data tidak lengkap' });

  try {
    const [user] = await db.query('SELECT pin FROM users WHERE email = ?', [email]);
    if (user.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const currentPin = user[0].pin;

    // JIKA USER BELUM PUNYA PIN: Langsung simpan tanpa peduli old_pin
    if (!currentPin) {
      await db.query('UPDATE users SET pin = ? WHERE email = ?', [new_pin, email]);
      return res.json({ success: true, message: 'PIN Transaksi berhasil dibuat!' });
    }

    // JIKA USER SUDAH PUNYA PIN: Validasi PIN lama
    if (currentPin !== old_pin) {
      return res.status(400).json({ success: false, message: 'PIN lama salah' });
    }

    // Eksekusi Update
    await db.query('UPDATE users SET pin = ? WHERE email = ?', [new_pin, email]);
    res.json({ success: true, message: 'PIN Pembayaran berhasil diperbarui' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Gagal mengubah PIN' });
  }
});
// =========================================================================
// 4. MANAJEMEN ADMIN
// =========================================================================
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, full_name as name, email, phone, role, created_at as joinDate, status 
       FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Get Users Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data pengguna' });
  }
});

app.put('/api/users/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Status tidak valid.' });
  }
  try {
    const [result] = await db.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    res.json({ message: `Status pengguna berhasil diubah menjadi ${status}.` });
  } catch (error) {
    console.error('Update Status Error:', error);
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
  } catch (error) {
    console.error('Admin Login Error:', error);
    res.status(500).json({ error: 'Gagal login admin' });
  }
});

app.get('/api/admin/verifications', async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT full_name as name, email, phone, ktp_image, selfie_image, owner_status as status 
       FROM users WHERE owner_status != "unverified"`
    );
    res.json(users);
  } catch (error) {
    console.error('Verifications Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data verifikasi' });
  }
});

app.put('/api/admin/verifications/action', async (req, res) => {
  const { email, action } = req.body;
  try {
    await db.query('UPDATE users SET owner_status = ? WHERE email = ?', [action, email]);
    res.json({ message: `Status berhasil diubah menjadi ${action}` });
  } catch (error) {
    console.error('Verification Action Error:', error);
    res.status(500).json({ error: 'Gagal memproses verifikasi' });
  }
});

app.listen(5001, () => console.log('✅ User Service berjalan di Port 5001'));