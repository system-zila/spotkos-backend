require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ✅ FIX NGROK: Bypass interstitial page
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.post('/api/rooms/register', upload.array('photos', 6), async (req, res) => {
  const {
    email, name, location, address, price, gender, description,
    roomSize, capacity, totalRooms, bathroom, floor, ownerName,
    ownerPhone, facilities, rules, latitude, longitude
  } = req.body;

  const photoPaths = req.files ? req.files.map(file => file.path.replace(/\\/g, '/')) : [];
  const mainImage = photoPaths.length > 0 ? photoPaths[0] : null;

  try {
    const [existing] = await db.query(
      'SELECT id FROM rooms WHERE LOWER(name) = LOWER(?) AND LOWER(location) = LOWER(?)',
      [name, location]
    );
    if (existing.length > 0) return res.status(400).json({ error: 'Kos sudah terdaftar!' });

    const [userCheck] = await db.query('SELECT role FROM users WHERE email = ?', [email]);
    const userRole = userCheck.length > 0 ? userCheck[0].role : 'user';

    if (userRole !== 'admin') {
      const [today] = await db.query(
        'SELECT id FROM rooms WHERE owner_email = ? AND DATE(created_at) = CURDATE()',
        [email]
      );
      if (today.length >= 1) {
        return res.status(400).json({ error: 'Batas kuota 1 kos per hari.' });
      }
    }

    // ✅ FIX BUG #8: Status 'pending' untuk user biasa, 'approved' hanya untuk admin
    const roomStatus = userRole === 'admin' ? 'approved' : 'pending';

    const [result] = await db.query(
      `INSERT INTO rooms (
        name, location, address, price, gender, description, room_size, capacity,
        bathroom_type, floor_range, owner_name, owner_phone, owner_email, facilities,
        rules, image, images, status, latitude, longitude
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, location, address, price, gender, description, roomSize, capacity,
        bathroom, floor, ownerName, ownerPhone, email, facilities, rules,
        mainImage, JSON.stringify(photoPaths), roomStatus, latitude, longitude
      ]
    );

    const newRoomId = result.insertId;

    // Logika Baru: Deteksi jika frontend mengirim data kustom per lantai
    let parsedFloors = [];
    if (req.body.floorsData) {
      try {
        parsedFloors = JSON.parse(req.body.floorsData); // Ekspektasi format: [{ name: "Lantai 1", capacity: 5 }, { name: "Lantai 2", capacity: 10 }]
      } catch (e) { console.error('Gagal parse floorsData', e); }
    }

    if (parsedFloors.length > 0) {
      // 1. Jika pengguna mengatur manual
      for (let f of parsedFloors) {
        await db.query(
          'INSERT INTO room_floors (room_id, floor_name, available_rooms, total_rooms) VALUES (?, ?, ?, ?)',
          [newRoomId, f.name, parseInt(f.capacity), parseInt(f.capacity)]
        );
      }
    } else {
      // 2. Fallback: Jika pengguna menggunakan sistem lama (dibagi rata otomatis)
      const totalFloorsCount = parseInt(floor) || 1;
      const totalRoomsCount = parseInt(totalRooms) || 1;
      const roomsPerFloor = Math.floor(totalRoomsCount / totalFloorsCount);
      const remainder = totalRoomsCount % totalFloorsCount;

      for (let i = 1; i <= totalFloorsCount; i++) {
        const floorName = `Lantai ${i}`;
        const floorCapacity = i === 1 ? roomsPerFloor + remainder : roomsPerFloor;
        await db.query(
          'INSERT INTO room_floors (room_id, floor_name, available_rooms, total_rooms) VALUES (?, ?, ?, ?)',
          [newRoomId, floorName, floorCapacity, floorCapacity]
        );
      }
    }

    if (userRole === 'user') {
      await db.query('UPDATE users SET role = "owner" WHERE email = ?', [email]);
    }

    res.json({
      message: userRole === 'admin'
        ? 'Kos berhasil didaftarkan dan langsung aktif.'
        : 'Kos berhasil didaftarkan. Menunggu persetujuan admin.'
    });
  } catch (error) {
    console.error('Register Room Error:', error);
    res.status(500).json({ error: 'Gagal menyimpan data.' });
  }
});

// ✅ FIX BUG #8: Endpoint untuk admin approve/reject kos
app.put('/api/rooms/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['approved', 'pending', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status tidak valid.' });
  }
  try {
    await db.query('UPDATE rooms SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: `Status kos berhasil diubah menjadi ${status}` });
  } catch (error) {
    console.error('Update Room Status Error:', error);
    res.status(500).json({ error: 'Gagal mengubah status kos.' });
  }
});

app.get('/api/rooms/my-kosts', async (req, res) => {
  const { email } = req.query;
  try {
    const [rooms] = await db.query(
      `SELECT r.*,
              (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE room_id = r.id) AS rating,
              (SELECT COUNT(id) FROM reviews WHERE room_id = r.id) AS reviews_count
       FROM rooms r 
       WHERE owner_email = ? 
       ORDER BY created_at DESC`,
      [email]
    );
    res.json(rooms);
  } catch (error) {
    console.error('My Kosts Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data properti kos.' });
  }
});

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

// Endpoint untuk menghapus kos (Digunakan oleh Owner di MyKost & Admin)
app.delete('/api/rooms/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Hapus data lantai yang terkait dengan kos ini
    await db.query('DELETE FROM room_floors WHERE room_id = ?', [id]);
    
    // 2. Hapus data ulasan yang terkait
    await db.query('DELETE FROM reviews WHERE room_id = ?', [id]);
    
    // 3. Hapus data pesanan (booking) yang terkait agar tidak error relasi
    await db.query('DELETE FROM bookings WHERE room_id = ?', [id]);

    // 4. Hapus data utama properti kos
    const [result] = await db.query('DELETE FROM rooms WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Data properti kos tidak ditemukan.' });
    }

    res.json({ message: 'Properti kos berhasil dihapus secara permanen.' });
  } catch (error) {
    console.error('Delete Room Error:', error);
    res.status(500).json({ error: 'Gagal menghapus properti kos akibat kesalahan server.' });
  }
});

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

app.get('/api/rooms/admin/all', async (req, res) => {
  try {
    const [rooms] = await db.query(
      "SELECT id, name, location, price, owner_name, owner_email, status, image FROM rooms ORDER BY created_at DESC"
    );
    res.json(rooms);
  } catch (error) {
    console.error('Admin Rooms Error:', error);
    res.status(500).json({ error: 'Gagal mengambil data kos.' });
  }
});

app.put('/api/rooms/admin/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, status } = req.body;
  try {
    await db.query(
      'UPDATE rooms SET name = ?, price = ?, status = ? WHERE id = ?', 
      [name, price, status, id]
    );
    res.json({ message: 'Data kos berhasil diperbarui.' });
  } catch (error) {
    console.error('Admin Edit Room Error:', error);
    res.status(500).json({ error: 'Gagal memperbarui kos.' });
  }
});

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

app.listen(5002, () => console.log('✅ Room Service berjalan di port 5002'));
