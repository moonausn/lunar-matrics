// ============================================
// LUNAR METRICS · MASTER BACKEND (With Diagnostics)
// ============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');

// -----------------------------
// 1. ENVIRONMENT VARIABLES
// -----------------------------
const {
    FIREBASE_WEB_API_KEY,
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
    ADSTERRA_API_KEY,
    ADSTERRA_BASE_URL,
    JWT_SECRET
} = process.env;

// Log to verify variables are set (without exposing secrets)
console.log('✅ Environment loaded:');
console.log(`  FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID || '❌ MISSING'}`);
console.log(`  FIREBASE_CLIENT_EMAIL: ${FIREBASE_CLIENT_EMAIL || '❌ MISSING'}`);
console.log(`  ADSTERRA_BASE_URL: ${ADSTERRA_BASE_URL || '❌ MISSING'}`);
console.log(`  JWT_SECRET: ${JWT_SECRET ? '✅ Set' : '❌ MISSING'}`);

if (!FIREBASE_WEB_API_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !ADSTERRA_API_KEY || !JWT_SECRET) {
    console.error('❌ Missing required environment variables. Exiting.');
    process.exit(1);
}

// -----------------------------
// 2. FIREBASE ADMIN SDK INIT
// -----------------------------
let db;
try {
    const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: FIREBASE_PROJECT_ID,
            clientEmail: FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey,
        }),
    });
    db = admin.firestore();
    console.log('✅ Firebase Admin SDK initialized successfully.');
} catch (error) {
    console.error('❌ Firebase initialization failed:', error.message);
    // Don't exit, but the app will not work fully. We can still serve /api/test.
}

// -----------------------------
// 3. EXPRESS APP SETUP (CORS FIXED)
// -----------------------------
const app = express();

// ----- CORS CONFIGURATION -----
const allowedOrigins = [
    'https://lunar-metrics.page.gd',        // Your InfinityFree domain
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn('Blocked by CORS:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// ----- DIAGNOSTIC ENDPOINT (ALWAYS WORKS) -----
app.get('/api/test', (req, res) => {
    res.json({
        status: 'ok',
        message: 'CORS is working! Backend is reachable.',
        timestamp: new Date().toISOString(),
        env: {
            firebaseProject: FIREBASE_PROJECT_ID || 'not set',
            adsterraBaseUrl: ADSTERRA_BASE_URL || 'not set',
        }
    });
});

// -----------------------------
// 4. AUTH MIDDLEWARE (JWT Verifier)
// -----------------------------
const authMiddleware = (requiredRole = null) => {
    return async (req, res, next) => {
        try {
            const token = req.headers.authorization?.split('Bearer ')[1];
            if (!token) {
                return res.status(401).json({ message: 'Unauthorized: No token provided' });
            }

            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;

            if (requiredRole && decoded.role !== requiredRole) {
                return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
            }

            next();
        } catch (error) {
            return res.status(401).json({ message: 'Invalid or expired token' });
        }
    };
};

// -----------------------------
// 5. FIREBASE REST API HELPER
// -----------------------------
const firebaseAuth = async (email, password) => {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
    const response = await axios.post(url, {
        email,
        password,
        returnSecureToken: true,
    });
    return response.data;
};

// -----------------------------
// 6. ADSTERRA HELPER (Placeholder)
// -----------------------------
const fetchAdsterraStats = async (dateFrom, dateTo, linkIds = []) => {
    const url = `${ADSTERRA_BASE_URL}/statistics`;
    try {
        const response = await axios.get(url, {
            params: { from: dateFrom, to: dateTo },
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        });
        return response.data;
    } catch (error) {
        console.error('Adsterra API Error:', error.response?.data || error.message);
        throw new Error('Failed to fetch stats from Adsterra');
    }
};

const mapAdsterraToMetrics = (rawData) => {
    return {
        impressions: rawData.impressions || 0,
        clicks: rawData.clicks || 0,
        cpm: rawData.cpm || 0,
        rpm: rawData.rpm || 0,
        revenue: rawData.revenue || 0,
    };
};

// -----------------------------
// 7. AUTH ENDPOINTS (with error handling)
// -----------------------------

app.post('/api/auth/admin-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }

        const authData = await firebaseAuth(email, password);
        const uid = authData.localId;

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(403).json({ message: 'Access denied: User not found' });
        }

        const userData = userDoc.data();
        if (userData.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied: Not an administrator' });
        }

        const token = jwt.sign(
            { uid, email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, message: 'Admin login successful' });
    } catch (error) {
        console.error('Admin login error:', error.response?.data || error.message);
        if (error.response?.data?.error?.message) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/api/auth/user-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }

        const authData = await firebaseAuth(email, password);
        const uid = authData.localId;

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(403).json({ message: 'Access denied: User not found' });
        }

        const userData = userDoc.data();
        if (userData.role !== 'user') {
            return res.status(403).json({ message: 'Access denied: Invalid user role' });
        }

        const token = jwt.sign(
            { uid, email, role: 'user' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, message: 'User login successful' });
    } catch (error) {
        console.error('User login error:', error.response?.data || error.message);
        if (error.response?.data?.error?.message) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        res.status(500).json({ message: 'Internal server error' });
    }
});

// -----------------------------
// 8. ADMIN ENDPOINTS (Placeholder – add your full logic)
// -----------------------------
app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    res.json([{ id: '123', name: 'Test Smartlink', status: 'available' }]);
});

app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    res.json([]);
});

app.post('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    res.status(201).json({ message: 'User created (placeholder)' });
});

app.delete('/api/admin/users/:uid', authMiddleware('admin'), async (req, res) => {
    res.json({ message: 'User deleted (placeholder)' });
});

app.post('/api/admin/assign', authMiddleware('admin'), async (req, res) => {
    res.json({ message: 'Assigned (placeholder)' });
});

app.post('/api/admin/unassign', authMiddleware('admin'), async (req, res) => {
    res.json({ message: 'Unassigned (placeholder)' });
});

app.patch('/api/admin/permissions', authMiddleware('admin'), async (req, res) => {
    res.json({ message: 'Permission updated (placeholder)' });
});

// -----------------------------
// 9. USER STATS (Placeholder)
// -----------------------------
app.get('/api/user/stats', authMiddleware('user'), async (req, res) => {
    res.json({
        userEmail: 'user@example.com',
        smartlink: { id: '123', name: 'Test Link' },
        permissions: { impressions: true, clicks: true, cpm: true, rpm: true, revenue: true },
        metrics: { impressions: 1000, clicks: 50, cpm: 2.5, rpm: 1.8, revenue: 15.0 },
    });
});

// -----------------------------
// 10. ROOT / HEALTH CHECK
// -----------------------------
app.get('/api', (req, res) => {
    res.json({
        name: 'Lunar Metrics API',
        version: '1.0.0',
        status: 'operational',
        timestamp: new Date().toISOString(),
    });
});

// -----------------------------
// 11. EXPORT
// -----------------------------
module.exports = app;
