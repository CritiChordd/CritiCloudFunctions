// functions/index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { faker } = require("@faker-js/faker");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// Utilidad: obtiene la clave secreta desde config o env (preferible usar firebase functions:config:set)
const SEED_KEY =
  (functions.config && functions.config().seed && functions.config().seed.key) ||
  process.env.SEED_KEY ||
  "dev-seed-key";

/**
 * Generadores de datos falsos
 */
function makeFakeUser() {
  const id = faker.string.uuid();
  const username = faker.internet.userName().replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  const name = faker.person.fullName();
  const profileImageUrl = faker.image.avatar();
  const email = faker.internet.email();
  return {
    id,
    username,
    email,
    name,
    bio: faker.lorem.sentence(),
    profileImageUrl,
    avatarUrl: profileImageUrl,
    usernameLowercase: username.toLowerCase(),
    nameLowercase: name.toLowerCase(),
    followers: 0,
    followersCount: 0,
    following: 0,
    followingCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

function makeFakeArtist() {
  const id = faker.number.int({ min: 1000, max: 9999 });
  return {
    id,
    name: faker.music.artist(),
    profileImageUrl: faker.image.urlPicsum(),
    genre: faker.music.genre(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

function makeFakeAlbum(artist) {
  const id = faker.number.int({ min: 10000, max: 99999 });
  return {
    id,
    title: faker.music.songName(),
    year: `${faker.date.past({ years: 30 }).getFullYear()}`,
    coverUrl: faker.image.urlPicsum(),
    artist: {
      id: artist.id,
      name: artist.name,
      profileImageUrl: artist.profileImageUrl,
      genre: artist.genre
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

function makeFakeReview(userId, albumId) {
  return {
    content: faker.lorem.paragraph(),
    score: faker.number.int({ min: 0, max: 100 }),
    isLowScore: false,
    albumId,
    userId,
    firebaseUserId: userId,
    likesCount: faker.number.int({ min: 0, max: 50 }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Endpoint: /seedData
 * Método: GET o POST
 * Parámetros:
 *   - key (query o header 'x-seed-key'): clave secreta para autorizar
 *   - users, artists, albums, reviews (opcional) números para controlar la cantidad
 */
exports.seedData = functions.https.onRequest(async (req, res) => {
  try {
    const key =
      req.query.key ||
      req.get("x-seed-key") ||
      (req.body && req.body.key) ||
      "";

    if (!key || key !== SEED_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized (invalid key)" });
    }

    // Cantidades por defecto, puedes pasarlas en query string ?users=20&artists=5...
    const usersCount = Math.min(Number(req.query.users || req.body?.users || 20), 500);
    const artistsCount = Math.min(Number(req.query.artists || req.body?.artists || 8), 200);
    const albumsPerArtist = Math.min(Number(req.query.albumsPerArtist || 3), 20);
    const reviewsPerUser = Math.min(Number(req.query.reviewsPerUser || 2), 20);

    const users = [];
    for (let i = 0; i < usersCount; i++) users.push(makeFakeUser());

    // Crear artistas y álbumes
    const artists = [];
    const albums = [];
    for (let i = 0; i < artistsCount; i++) {
      const art = makeFakeArtist();
      artists.push(art);
      for (let j = 0; j < albumsPerArtist; j++) {
        albums.push(makeFakeAlbum(art));
      }
    }

    // Crear reseñas: asignar aleatoriamente users -> albums
    const reviews = [];
    for (const u of users) {
      for (let r = 0; r < reviewsPerUser; r++) {
        const album = faker.helpers.arrayElement(albums);
        reviews.push(makeFakeReview(u.id, album.id));
      }
    }

    // Escribir en Firestore usando batches de 500
    const BATCH_SIZE = 500;
    async function commitBatchOps(ops) {
      let batch = db.batch();
      let count = 0;
      for (const op of ops) {
        const { ref, data } = op;
        batch.set(ref, data, { merge: true });
        count++;
        if (count >= BATCH_SIZE) {
          await batch.commit();
          batch = db.batch();
          count = 0;
        }
      }
      if (count > 0) await batch.commit();
    }

    const ops = [];

    // users -> collection 'users', doc id = user.id
    for (const u of users) {
      const ref = db.collection("users").doc(u.id);
      // normalizar algunos campos que tu front espera
      const payload = {
        id: u.id,
        username: u.username,
        email: u.email,
        name: u.name,
        bio: u.bio,
        profileImageUrl: u.profileImageUrl,
        avatarUrl: u.avatarUrl,
        usernameLowercase: u.usernameLowercase,
        nameLowercase: u.nameLowercase,
        followers: 0,
        followersCount: 0,
        following: 0,
        followingCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      ops.push({ ref, data: payload });
    }

    // artists -> collection 'artists', doc id = artist.id (string)
    for (const a of artists) {
      ops.push({ ref: db.collection("artists").doc(a.id.toString()), data: a });
    }

    // albums -> collection 'albums', doc id = album.id (string)
    for (const al of albums) {
      ops.push({
        ref: db.collection("albums").doc(al.id.toString()),
        data: {
          id: al.id,
          title: al.title,
          year: al.year,
          coverUrl: al.coverUrl,
          artist: al.artist,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }
      });
    }

    // reviews -> collection 'reviews', doc id auto
    for (const rv of reviews) {
      ops.push({
        ref: db.collection("reviews").doc(),
        data: rv
      });
    }

    // Ejecutar commits
    await commitBatchOps(ops);

    return res.json({
      ok: true,
      message: "Seeding completed",
      counts: {
        users: users.length,
        artists: artists.length,
        albums: albums.length,
        reviews: reviews.length
      }
    });
  } catch (err) {
    console.error("Seed error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * Endpoint: /updateUser
 * Método: POST
 * Body: { key: "...", id: "...", updates: { username: "...", bio: "...", profileImageUrl: "..." } }
 * Retorna el documento actualizado.
 */
exports.updateUser = functions.https.onRequest(async (req, res) => {
  try {
    const key = req.body?.key || req.query?.key || req.get("x-seed-key") || "";
    if (!key || key !== SEED_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized (invalid key)" });
    }

    const id = req.body?.id || req.query?.id;
    const updates = req.body?.updates || req.query?.updates;

    if (!id || !updates || typeof updates !== "object") {
      return res.status(400).json({ ok: false, error: "Bad request: missing id or updates" });
    }

    const userRef = db.collection("users").doc(id);
    await userRef.update({
      ...updates,
      usernameLowercase: updates.username ? String(updates.username).toLowerCase() : undefined,
      nameLowercase: updates.name ? String(updates.name).toLowerCase() : undefined,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const updated = await userRef.get();
    return res.json({ ok: true, user: updated.data() });
  } catch (err) {
    console.error("updateUser error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});
