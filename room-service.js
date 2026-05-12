require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

// ✅ FIX: Gunakan shared DB pool agar koneksi stabil dan tidak ETIMEDOUT
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// Mengizinkan akses publik ke folder uploads untuk gambar kos dan artikel
app.use('/uploads', express.static('uploads'));

// =========================================================================
// KONFIGURASI MULTER UNTUK UPLOAD FILE
// =========================================================================
// Digunakan untuk menangani upload banyak foto sekaligus (array) pada pendaftaran kos
// maupun upload single foto pada thumbnail artikel
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Menyimpan file di folder uploads lokal
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // Memberikan nama unik menggunakan timestamp agar tidak ada konflik nama file
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// =========================================================================
// 1. MANAJEMEN KOST (ROOMS)
// =========================================================================

/**
 * ENDPOINT: Mendaftarkan Kos Baru
 * ✅ FIX BUG #8: Status kamar sekarang dinamis. 
 * Jika pendaftar adalah Admin -> langsung 'approved'.
 * Jika pendaftar adalah User/Owner -> 'pending' (menunggu persetujuan Admin).
 */
app.post('/api/rooms/register', upload.array('photos', 6), async (req, res) => {
  const {
    email, name, location, address, price, gender, description,
    roomSize, capacity, totalRooms, bathroom, floor, ownerName,
    ownerPhone, facilities, rules, latitude, longitude
  } = req.body;

  // Format path foto agar terbaca dengan baik di frontend
  const photoPaths = req.files ? req.files.map(file => file.path.replace(/\\/g, '/')) : [];
  const mainImage = photoPaths.length > 0 ? photoPaths[0] : null;

  try {
    // 1. Cek duplikasi kos berdasarkan nama dan lokasi
    const [existing] = await db.query(
      'SELECT id FROM rooms WHERE LOWER(name) = LOWER(?) AND LOWER(location) = LOWER(?)',
      [name, location]
    );
    if (existing.length > 0) return res.status(400).json({ error: 'Kos sudah terdaftar!' });

    // 2. Cek Role User yang mendaftar
    const [userCheck] = await db.query('SELECT role FROM users WHERE email = ?', [email]);
    const userRole = userCheck.length > 0 ? userCheck[0].role : 'user';

    // 3. Batasi kuota spam (hanya untuk user non-admin)
    if (userRole !== 'admin') {
      const [today] = await db.query(
        'SELECT id FROM rooms WHERE owner_email = ? AND DATE(created_at) = CURDATE()',
        [email]
      );
      if (today.length >= 1) {
        return res.status(400).json({ error: 'Batas kuota 1 kos per hari.' });
      }
    }

    // ✅ FIX BUG #8: Tentukan status berdasarkan Role
    const roomStatus = userRole === 'admin' ? 'approved' : 'pending';

    // 4. Masukkan data kos ke database
    const [result] = await db.query(
      `INSERT INTO rooms (
        name, location, address, price, gender, description, room_size, capacity,
        bathroom_type, floor_range, owner_name, owner_phone, owner_email, facilities,
        rules, image, images, status, latitude, longitude
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, // <- status diganti jadi parameter '?'
      [
        name, location, address, price, gender, description, roomSize, capacity,
        bathroom, floor, ownerName, ownerPhone, email, facilities, rules,
        mainImage, JSON.stringify(photoPaths), roomStatus, latitude, longitude // <- memasukkan nilai roomStatus
      ]
    );

    const newRoomId = result.insertId;
    
    // 5. Hitung dan sebarkan kamar ke setiap lantai
    const totalFloorsCount = parseInt(floor) || 1;
    const totalRoomsCount = parseInt(totalRooms) || 1;
    const roomsPerFloor = Math.floor(totalRoomsCount / totalFloorsCount);
    const remainder = totalRoomsCount % totalFloorsCount;

    for (let i = 1; i <= totalFloorsCount; i++) {
      const floorName = `Lantai ${i}`;
      // Sisa kamar (remainder) ditambahkan ke lantai 1
      const floorCapacity = i === 1 ? roomsPerFloor + remainder : roomsPerFloor;
      await db.query(
        'INSERT INTO room_floors (room_id, floor_name, available_rooms, total_rooms) VALUES (?, ?, ?, ?)',
        [newRoomId, floorName, floorCapacity, floorCapacity]
      );
    }

    // 6. Jika pendaftar adalah user biasa, angkat statusnya menjadi owner
    if (userRole === 'user') {
      await db.query('UPDATE users SET role = "owner" WHERE email = ?', [email]);
    }

    res.json({ message: 'Pendaftaran kos berhasil.' });
  } catch (error) {
    console.error('Register Room Error:', error);
    res.status(500).json({ error: 'Gagal menyimpan data.' });
  }
});

/**
 * ENDPOINT: Mengambil daftar kos milik sendiri
 * Dipanggil di halaman MyKost.tsx
 */
app.get('/api/rooms/my-kosts', async (req, res) => {
  const { email } = req.query;
  try {
    const [rooms] = await db.query(
      'SELECT id, name, location, price, status, image FROM rooms WHERE owner_email = ? ORDER BY created_at DESC',
      [email]
    );
    res.json(rooms);
  } catch (error) {
    console.error('My Kosts Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data properti kos.' });
  }
});

/**
 * ENDPOINT: Mengambil semua daftar kos untuk halaman utama
 * Hanya menampilkan kos yang berstatus 'approved'
 */
app.get('/api/rooms', async (req, res) => {
  try {
    const [rooms] = await db.query(`
      SELECT r.*,
             (SELECT COALESCE(SUM(available_rooms), 0) FROM room_floors WHERE room_id = r.id) AS sisa_kamar,
             (SELECT COALESCE(SUM(total_rooms), 0) FROM room_floors WHERE room_id = r.id) AS total_kamar,
             (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE room_id = r.id) AS rating,
             (SELECT COUNT(id) FROM reviews WHERE room_id = r.id) AS reviews_count
      FROM rooms r
      WHERE r.status = 'approved'
      ORDER BY r.created_at DESC
    `);

    const formattedRooms = rooms.map(room => ({
      ...room,
      rating: parseFloat(room.rating).toFixed(1)
    }));

    res.json(formattedRooms);
  } catch (error) {
    console.error('Get Rooms Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data kos' });
  }
});

/**
 * ENDPOINT: Mengambil detail satu kos secara spesifik
 * Dipanggil di halaman RoomDetail.tsx
 */
app.get('/api/rooms/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rooms] = await db.query('SELECT * FROM rooms WHERE id = ?', [id]);
    if (rooms.length === 0) return res.status(404).json({ error: 'Kos tidak ditemukan' });

    const roomData = rooms[0];
    const [floors] = await db.query(
      'SELECT * FROM room_floors WHERE room_id = ? ORDER BY floor_name ASC',
      [id]
    );
    roomData.floorsData = floors;

    res.json(roomData);
  } catch (error) {
    console.error('Get Room Detail Error:', error);
    res.status(500).json({ error: 'Gagal menarik data' });
  }
});

// =========================================================================
// 2. MANAJEMEN ULASAN (REVIEWS)
// =========================================================================

app.get('/api/rooms/:id/reviews', async (req, res) => {
  const { id } = req.params;
  try {
    const [reviews] = await db.query(
      `SELECT user_name as name, rating, comment, DATE_FORMAT(created_at, "%d %b %Y") as date 
       FROM reviews WHERE room_id = ? ORDER BY created_at DESC`,
      [id]
    );
    res.json(reviews);
  } catch (error) {
    console.error('Get Reviews Error:', error);
    res.status(500).json({ error: 'Gagal mengambil ulasan' });
  }
});

app.post('/api/rooms/:id/reviews', async (req, res) => {
  const { id } = req.params;
  const { email, name, rating, comment, bookingId } = req.body;
  try {
    const [existing] = await db.query('SELECT id FROM reviews WHERE booking_id = ?', [bookingId]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Anda sudah memberikan ulasan untuk pesanan ini.' });
    }

    await db.query(
      'INSERT INTO reviews (room_id, booking_id, user_email, user_name, rating, comment) VALUES (?, ?, ?, ?, ?, ?)',
      [id, bookingId, email, name, rating, comment]
    );
    res.json({ success: true, message: 'Ulasan berhasil disimpan' });
  } catch (error) {
    console.error('Post Review Error:', error);
    res.status(500).json({ error: 'Gagal mengirim ulasan' });
  }
});

// =========================================================================
// 3. MANAJEMEN ARTIKEL (BLOG)
// =========================================================================

app.get('/api/articles', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, title, excerpt, image, category, read_time as readTime, author, content, 
              DATE_FORMAT(created_at, "%d %b %Y") as date 
       FROM articles ORDER BY created_at DESC`
    );
    const articles = rows.map(row => ({
      ...row,
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content
    }));
    res.json(articles);
  } catch (error) {
    console.error('Get Articles Error:', error);
    res.status(500).json({ error: 'Gagal mengambil artikel' });
  }
});

app.post('/api/articles', async (req, res) => {
  const { title, excerpt, image, category, readTime, author, content } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO articles (title, excerpt, image, category, read_time, author, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, excerpt, image, category, readTime, author, JSON.stringify(content)]
    );
    res.json({ id: result.insertId });
  } catch (error) {
    console.error('Create Article Error:', error);
    res.status(500).json({ error: 'Gagal membuat artikel' });
  }
});

app.put('/api/articles/:id', async (req, res) => {
  const { id } = req.params;
  const { title, excerpt, image, category, readTime, author, content } = req.body;
  try {
    await db.query(
      'UPDATE articles SET title=?, excerpt=?, image=?, category=?, read_time=?, author=?, content=? WHERE id=?',
      [title, excerpt, image, category, readTime, author, JSON.stringify(content), id]
    );
    res.json({ message: 'Updated' });
  } catch (error) {
    console.error('Update Article Error:', error);
    res.status(500).json({ error: 'Gagal update artikel' });
  }
});

// =========================================================================
// 4. MANAJEMEN ADMIN KHUSUS KOS (APPROVAL)
// =========================================================================

/**
 * ✅ FIX BUG #8: ENDPOINT APPROVAL ADMIN
 * Endpoint ini baru ditambahkan agar panel admin bisa bekerja untuk mengubah
 * status kos yang masih 'pending' menjadi 'approved' atau 'rejected'.
 */
app.put('/api/rooms/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // status berisi: 'approved', 'rejected', atau 'pending'

  // Validasi input status
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Status tidak valid' });
  }

  try {
    const [result] = await db.query('UPDATE rooms SET status = ? WHERE id = ?', [status, id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Kamar kos tidak ditemukan' });
    }
    
    res.json({ message: `Status kos berhasil diperbarui menjadi ${status}` });
  } catch (error) {
    console.error('Update Room Status Error:', error);
    res.status(500).json({ error: 'Gagal memperbarui status kos' });
  }
});

// Menjalankan microservice kamar di Port 5002
app.listen(5002, () => console.log('✅ Room Service berjalan di port 5002'));