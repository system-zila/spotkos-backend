require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcryptjs');

// ✅ FIX: Gunakan shared DB pool dengan konfigurasi timeout yang benar
const db = require('./db');

const app = express();
app.use(express.json());

// Mengizinkan akses publik ke folder uploads untuk gambar KTP, Selfie, dan Avatar
app.use('/uploads', express.static('uploads'));

// ✅ FIX: OAuth2Client dibuat tanpa audience agar bisa verifikasi token dari semua device
// Audience di-pass saat verifyIdToken, bukan di konstruktor
const googleClient = new OAuth2Client();

// =========================================================================
// KONFIGURASI MULTER UNTUK UPLOAD FILE
// =========================================================================
// Konfigurasi ini menentukan di mana dan bagaimana file akan disimpan
// saat user mengunggah foto profil, KTP, atau foto selfie.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Semua file akan masuk ke dalam folder 'uploads/'
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // Membuat nama file yang unik untuk menghindari penumpukan/konflik file
    const uniqueFileName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueFileName);
  }
});
const upload = multer({ storage });

// =========================================================================
// HELPER: Buat URL avatar yang aman untuk production
// =========================================================================
/**
 * Fungsi ini memastikan format URL foto profil benar.
 * Jika dari Google, gunakan URL aslinya. Jika lokal, gabungkan dengan BASE_URL.
 */
function buildAvatarUrl(avatarValue) {
  if (!avatarValue) return null;
  
  // Jika sudah berupa URL lengkap (Google, CDN, dll), langsung pakai
  if (avatarValue.startsWith('http://') || avatarValue.startsWith('https://')) {
    return avatarValue;
  }
  
  // Jika path lokal, gunakan BASE_URL dari .env agar tidak hardcode localhost
  const base = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${base}/${avatarValue}`;
}

// =========================================================================
// 1. GOOGLE LOGIN - FIX UTAMA
// =========================================================================
app.post('/api/google-login', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token Google tidak ditemukan.' });
  }

  try {
    // ✅ FIX: Verifikasi token dengan audience yang benar
    // Tanpa ini, token dari device lain (Android, iOS, web lain) bisa ditolak
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(401).json({ error: 'Token Google tidak valid.' });
    }

    const { email, name, picture } = payload;

    // Mencari apakah email Google ini sudah ada di database
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      // User baru: daftarkan otomatis dengan password kosong
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

    // Pengecekan jika akun sedang di-suspend oleh admin
    if (users[0].status === 'suspended') {
      return res.status(403).json({ error: 'Akses Ditolak: Akun Anda telah dibekukan oleh Admin.' });
    }

    // Menggabungkan URL avatar
    const avatarUrl = buildAvatarUrl(users[0].avatar) || picture;

    // Mengembalikan data user ke frontend
    res.json({
      message: 'Login Google berhasil',
      user: {
        name: users[0].full_name,
        email: email,
        role: users[0].role,
        avatar: avatarUrl
      }
    });

  } catch (error) {
    console.error('Google Auth Error:', error.message);
    
    // ✅ FIX: Pesan error yang lebih informatif untuk debug
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
// 2. AUTENTIKASI REGULER (REGISTER & LOGIN)
// =========================================================================
/**
 * Endpoint Register
 * Berfungsi untuk mendaftarkan user baru secara manual (tanpa Google).
 */
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  
  try {
    // LOGIKA PENTING YANG DIPERTAHANKAN: Pengecekan Email Existing
    // Kita harus memastikan tidak ada duplikasi email di database
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ?', 
      [email]
    );
    
    if (existing.length > 0) {
      // Jika existing memiliki data, tolak proses registrasi
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    }

    // ✅ FIX BUG #7: Hashing Password
    // Kita wajib melakukan hashing sebelum password masuk ke query INSERT
    const hashedPassword = await bcrypt.hash(password, 10);

    // Proses penyimpanan data ke database
    await db.query(
      `INSERT INTO users 
        (full_name, email, password, role, notif_email, notif_sms, notif_promo, notif_reminder) 
       VALUES (?, ?, ?, "user", 1, 0, 0, 1)`,
      [name, email, hashedPassword] // Menggunakan hashedPassword, BUKAN password
    );
    
    res.json({ 
      message: 'Registrasi berhasil', 
      user: { name, email, role: 'user' } 
    });

  } catch (error) {
    console.error('Register Error:', error);
    res.status(500).json({ error: 'Gagal melakukan registrasi' });
  }
});

/**
 * Endpoint Login User
 * Berfungsi untuk masuk menggunakan email dan password manual.
 */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    // 1. Ambil data user berdasarkan email saja (karena password harus diverifikasi terpisah)
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    // 2. Pengecekan keberadaan user
    if (users.length === 0) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    const user = users[0];

    // 3. Pengecekan status suspend
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Akses Ditolak: Akun Anda telah dibekukan oleh Admin.' });
    }

    // 4. Pengecekan akun Google
    // Jika password kosong, berarti akun ini terdaftar via Google. Tolak login manual.
    if (user.password === '') {
      return res.status(401).json({ error: 'Gunakan tombol "Login with Google" untuk masuk ke akun ini.' });
    }

    // 5. ✅ FIX BUG #7: Verifikasi Password (Dengan Backward Compatibility)
    let validPassword = false;
    
    // Mengecek apakah password di database adalah hash bcrypt (diawali $2a$ atau $2b$)
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
      // Jika ya, gunakan fungsi compare bawaan bcrypt
      validPassword = await bcrypt.compare(password, user.password);
    } else {
      // Jika tidak, ini adalah akun lama (sebelum bug diperbaiki). Cocokkan secara manual.
      validPassword = (password === user.password);
    }

    // Jika password tidak cocok dengan metode manapun, tolak akses
    if (!validPassword) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    // Jika lolos semua validasi, buat URL avatar dan kirim respons sukses
    const avatarUrl = buildAvatarUrl(user.avatar);

    res.json({
      message: 'Login berhasil',
      user: {
        name: user.full_name,
        email: user.email,
        role: user.role,
        avatar: avatarUrl
      }
    });

  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Gagal melakukan login' });
  }
});

// =========================================================================
// 3. MANAJEMEN PROFIL USER
// =========================================================================
app.get('/api/users/profile', async (req, res) => {
  const { email } = req.query;
  try {
    const [users] = await db.query(
      `SELECT full_name as name, nickname, email, phone, gender, birth_info, 
              owner_status, avatar, bank_name, bank_account, bank_account_name, balance 
       FROM users WHERE email = ?`,
      [email]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'User tidak ditemukan' });
    }

    const user = users[0];
    user.avatar = buildAvatarUrl(user.avatar);
    res.json(user);
    
  } catch (error) {
    console.error('Profile Error:', error);
    res.status(500).json({ error: 'Gagal mengambil profil' });
  }
});

app.put('/api/users/update-avatar', upload.single('avatar'), async (req, res) => {
  const { email } = req.body;
  const avatarPath = req.file ? req.file.path.replace(/\\/g, '/') : null;
  
  if (!avatarPath) {
    return res.status(400).json({ error: 'File avatar tidak ditemukan.' });
  }
  
  try {
    await db.query(
      'UPDATE users SET avatar = ? WHERE email = ?', 
      [avatarPath, email]
    );
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
    const [result] = await db.query(
      'UPDATE users SET phone = ? WHERE email = ?', 
      [phone, email]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Akun tidak ditemukan' });
    }
    res.json({ message: 'Nomor telepon berhasil diperbarui' });
    
  } catch (error) {
    console.error('Update Phone Error:', error);
    res.status(500).json({ error: 'Gagal memperbarui nomor telepon' });
  }
});

app.put('/api/users/update-profile', async (req, res) => {
  const { email, field, value } = req.body;
  
  // Mapping nama field dari frontend ke kolom di database untuk menghindari SQL Injection
  const columnMap = {
    name: 'full_name', 
    nickname: 'nickname', 
    gender: 'gender',
    birth_info: 'birth_info', 
    address: 'address',
    bank_name: 'bank_name', 
    bank_account: 'bank_account', 
    bank_account_name: 'bank_account_name'
  };
  
  const dbColumn = columnMap[field];
  if (!dbColumn) {
    return res.status(400).json({ error: 'Field tidak valid' });
  }

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
  
  if (!email || !newPassword) {
    return res.status(400).json({ error: 'Email dan password baru wajib diisi' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  }

  try {
    // ✅ FIX BUG #7: Hashing Password untuk perubahan password
    // Password baru harus di-hash agar aman
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    const [result] = await db.query(
      'UPDATE users SET password = ? WHERE email = ?', 
      [hashedNewPassword, email]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }
    
    res.json({ message: 'Password berhasil diubah' });
    
  } catch (error) {
    console.error('Change Password Error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server' });
  }
});

// =========================================================================
// 4. MANAJEMEN ADMIN
// =========================================================================
app.get('/api/users', async (req, res) => {
  try {
    // Mengambil seluruh data user untuk ditampilkan di dashboard admin
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

  // Validasi ketat agar status yang dikirim hanya active atau suspended
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Status tidak valid.' });
  }

  try {
    const [result] = await db.query(
      'UPDATE users SET status = ? WHERE id = ?', 
      [status, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    }
    
    res.json({ message: `Status pengguna berhasil diubah menjadi ${status}.` });
    
  } catch (error) {
    console.error('Update Status Error:', error);
    res.status(500).json({ error: 'Gagal mengubah status pengguna.' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    // 1. Ambil data spesifik admin
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ? AND role = "admin"',
      [email]
    );
    
    // Jika data tidak ditemukan, tolak sebagai "Bukan admin"
    if (users.length === 0) {
      return res.status(401).json({ error: 'Bukan admin.' });
    }

    const admin = users[0];
    
    // 2. ✅ FIX BUG #7: Verifikasi Password Admin (Dengan Backward Compatibility)
    let validPassword = false;
    
    if (admin.password.startsWith('$2a$') || admin.password.startsWith('$2b$')) {
      // Jika hash bcrypt, verifikasi dengan bcrypt compare
      validPassword = await bcrypt.compare(password, admin.password);
    } else {
      // Jika plaintext (contoh akun admin123 yang lama), bandingkan manual
      validPassword = (password === admin.password);
    }

    if (!validPassword) {
      return res.status(401).json({ error: 'Sandi salah.' });
    }
    
    res.json({ message: 'Sukses' });
    
  } catch (error) {
    console.error('Admin Login Error:', error);
    res.status(500).json({ error: 'Gagal login admin' });
  }
});

app.get('/api/admin/verifications', async (req, res) => {
  try {
    // Mengambil user yang statusnya bukan "unverified" (berarti sedang pending, approved, dsb)
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
    // Admin melakukan approve/reject pada status verifikasi KTP owner
    await db.query(
      'UPDATE users SET owner_status = ? WHERE email = ?', 
      [action, email]
    );
    res.json({ message: `Status berhasil diubah menjadi ${action}` });
    
  } catch (error) {
    console.error('Verification Action Error:', error);
    res.status(500).json({ error: 'Gagal memproses verifikasi' });
  }
});

// Menjalankan microservice user di Port 5001
app.listen(5001, () => {
  console.log('✅ User Service berjalan di Port 5001');
});