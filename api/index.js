// ============================================
// LUNAR METRICS · MASTER BACKEND
// Robust Adsterra Integration with Fallback
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

console.log('✅ Environment loaded:');
console.log(`  FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID || '❌ MISSING'}`);
console.log(`  ADSTERRA_BASE_URL: ${ADSTERRA_BASE_URL || '❌ MISSING'}`);
console.log(`  JWT_SECRET: ${JWT_SECRET ? '✅ Set' : '❌ MISSING'}`);

if (!FIREBASE_WEB_API_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !ADSTERRA_API_KEY || !JWT_SECRET) {
    console.error('❌ Missing required environment variables.');
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
}

// -----------------------------
// 3. EXPRESS APP SETUP (CORS)
// -----------------------------
const app = express();

const allowedOrigins = [
    'https://lunar-metrics.page.gd',
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

// ----- DIAGNOSTIC ENDPOINT -----
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
// 4. AUTH MIDDLEWARE
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
    const response = await axios.post(url, { email, password, returnSecureToken: true });
    return response.data;
};

// -----------------------------
// 6. ADSTERRA API HELPERS (ROBUST)
// -----------------------------

/**
 * Fetch Smartlinks from Adsterra with multiple authentication attempts
 */
const fetchSmartlinksFromAdsterra = async () => {
    // Try different possible endpoints
    const endpoints = [
        '/smartlinks',
        '/placements',
        '/campaigns',
        '/stats/smartlinks',
    ];

    // Try different authentication methods
    const authMethods = [
        { type: 'bearer', header: `Bearer ${ADSTERRA_API_KEY}` },
        { type: 'api-key', header: ADSTERRA_API_KEY },
        { type: 'query', param: 'api_key' },
        { type: 'query', param: 'key' },
        { type: 'query', param: 'token' },
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
        for (const auth of authMethods) {
            try {
                const url = `${ADSTERRA_BASE_URL}${endpoint}`;
                const config = {
                    headers: { 'Accept': 'application/json' },
                    params: {},
                };

                if (auth.type === 'bearer') {
                    config.headers['Authorization'] = auth.header;
                } else if (auth.type === 'api-key') {
                    config.headers['Api-Key'] = auth.header;
                    config.headers['X-Api-Key'] = auth.header;
                } else if (auth.type === 'query') {
                    config.params[auth.param] = ADSTERRA_API_KEY;
                }

                console.log(`🔄 Trying Adsterra: ${url} (${auth.type})`);
                const response = await axios.get(url, config);

                if (response.status === 200 && response.data) {
                    console.log(`✅ Adsterra API success: ${endpoint} (${auth.type})`);
                    // Parse response - try to find array of objects with id/name
                    let data = response.data;
                    if (data.data && Array.isArray(data.data)) data = data.data;
                    if (data.items && Array.isArray(data.items)) data = data.items;
                    if (data.result && Array.isArray(data.result)) data = data.result;
                    if (!Array.isArray(data)) data = [data];

                    // Map to our format
                    return data.map(item => ({
                        id: item.id || item.placement_id || item.smartlink_id || item.campaign_id || String(item),
                        name: item.name || item.label || item.title || item.placement_name || 'Unnamed',
                    }));
                }
            } catch (error) {
                lastError = error;
                // Continue to next auth method or endpoint
            }
        }
    }

    // If all attempts fail, log and throw
    console.error('❌ All Adsterra API attempts failed. Last error:', lastError?.message);
    throw new Error('Failed to fetch smartlinks from Adsterra. Check API key and base URL.');
};

/**
 * Fetch statistics from Adsterra
 */
const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    try {
        const url = `${ADSTERRA_BASE_URL}/statistics`;
        const params = { from: dateFrom, to: dateTo };
        if (smartlinkId) {
            params.placement_id = smartlinkId;
        }

        const config = {
            params: params,
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        };

        // Also try with query param if bearer fails
        try {
            const response = await axios.get(url, config);
            let statsData = response.data;
            if (statsData.data && statsData.data.items) statsData = statsData.data.items;
            if (Array.isArray(statsData)) {
                if (smartlinkId) {
                    const found = statsData.find(item =>
                        (item.placement_id && item.placement_id == smartlinkId) ||
                        (item.smartlink_id && item.smartlink_id == smartlinkId)
                    );
                    return found || {};
                }
                return statsData;
            }
            return statsData;
        } catch (bearerError) {
            // Fallback to query param
            const fallbackConfig = {
                params: { ...params, api_key: ADSTERRA_API_KEY },
                headers: { 'Accept': 'application/json' },
            };
            const response = await axios.get(url, fallbackConfig);
            return response.data;
        }
    } catch (error) {
        console.error('Adsterra Stats fetch error:', error.message);
        return { impressions: 0, clicks: 0, cpm: 0, rpm: 0, revenue: 0 };
    }
};

const mapStatsToMetrics = (rawStats) => ({
    impressions: rawStats.impressions || 0,
    clicks: rawStats.clicks || 0,
    cpm: rawStats.cpm || 0,
    rpm: rawStats.rpm || 0,
    revenue: rawStats.revenue || 0,
});

// ============================================
// 7. AUTH ENDPOINTS
// ============================================
app.post('/api/auth/admin-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

        const authData = await firebaseAuth(email, password);
        const uid = authData.localId;

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(403).json({ message: 'Access denied: User not found' });

        const userData = userDoc.data();
        if (userData.role !== 'admin') return res.status(403).json({ message: 'Access denied: Not an administrator' });

        const token = jwt.sign({ uid, email, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, message: 'Admin login successful' });
    } catch (error) {
        console.error('Admin login error:', error.response?.data || error.message);
        if (error.response?.data?.error?.message) return res.status(401).json({ message: 'Invalid email or password' });
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/api/auth/user-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

        const authData = await firebaseAuth(email, password);
        const uid = authData.localId;

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(403).json({ message: 'Access denied: User not found' });

        const userData = userDoc.data();
        if (userData.role !== 'user') return res.status(403).json({ message: 'Access denied: Invalid user role' });

        const token = jwt.sign({ uid, email, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, message: 'User login successful' });
    } catch (error) {
        console.error('User login error:', error.response?.data || error.message);
        if (error.response?.data?.error?.message) return res.status(401).json({ message: 'Invalid email or password' });
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ============================================
// 8. ADMIN ENDPOINTS (WITH FALLBACK)
// ============================================

app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    try {
        let adsterraLinks = [];
        try {
            adsterraLinks = await fetchSmartlinksFromAdsterra();
        } catch (error) {
            console.warn('⚠️ Adsterra API failed, using fallback mock data.');
            // Fallback: Return mock data so admin panel at least shows something
            adsterraLinks = [
                { id: '30979549', name: 'MN02-D' },
                { id: '30979548', name: 'MN02-C' },
                { id: '30979544', name: 'MN02-B' },
                { id: '30979542', name: 'MN02-A' },
                { id: '30853036', name: 'Moon' },
            ];
        }

        // Fetch assignments from Firestore
        const assignmentsSnapshot = await db.collection('assignments').get();
        const assignments = {};
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            assignments[data.smartlinkId] = {
                userEmail: data.userEmail,
                userId: data.userId,
            };
        });

        const smartlinks = adsterraLinks.map(link => {
            const assigned = assignments[link.id];
            return {
                ...link,
                status: assigned ? 'assigned' : 'available',
                assignedTo: assigned ? assigned.userEmail : null,
                assignedUserId: assigned ? assigned.userId : null,
            };
        });

        res.json(smartlinks);
    } catch (error) {
        console.error('Smartlinks fetch error:', error.message);
        res.status(500).json({ message: 'Failed to fetch smartlinks', error: error.message });
    }
});

// --- GET Users (from Firestore) ---
app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        const users = [];
        for (const doc of usersSnapshot.docs) {
            const data = doc.data();
            let smartlinkName = null;
            if (data.smartlinkId) {
                const assignmentDoc = await db.collection('assignments').doc(data.smartlinkId).get();
                if (assignmentDoc.exists) {
                    smartlinkName = assignmentDoc.data().smartlinkName || data.smartlinkId;
                } else {
                    smartlinkName = data.smartlinkId;
                }
            }
            users.push({
                id: doc.id,
                email: data.email,
                role: data.role,
                permissions: data.permissions || {},
                smartlinkId: data.smartlinkId || null,
                smartlinkName: smartlinkName,
            });
        }
        res.json(users);
    } catch (error) {
        console.error('Users fetch error:', error);
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

// --- POST Create User ---
app.post('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

        const userRecord = await admin.auth().createUser({ email, password, emailVerified: false, disabled: false });
        await db.collection('users').doc(userRecord.uid).set({
            email,
            role: 'user',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            permissions: { impressions: true, clicks: true, cpm: true, rpm: true, revenue: true },
            smartlinkId: null,
        });

        res.status(201).json({ message: 'User created successfully', uid: userRecord.uid });
    } catch (error) {
        console.error('Create user error:', error);
        if (error.code === 'auth/email-already-exists') return res.status(400).json({ message: 'Email already exists' });
        res.status(500).json({ message: 'Failed to create user' });
    }
});

// --- DELETE User ---
app.delete('/api/admin/users/:uid', authMiddleware('admin'), async (req, res) => {
    try {
        const { uid } = req.params;
        await admin.auth().deleteUser(uid);
        await db.collection('users').doc(uid).delete();
        const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
        const batch = db.batch();
        assignmentsSnapshot.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ message: 'Failed to delete user' });
    }
});

// --- ASSIGN Smartlink ---
app.post('/api/admin/assign', authMiddleware('admin'), async (req, res) => {
    try {
        const { email, smartlinkId } = req.body;
        if (!email || !smartlinkId) return res.status(400).json({ message: 'Email and Smartlink ID required' });

        const userSnapshot = await db.collection('users').where('email', '==', email).where('role', '==', 'user').get();
        if (userSnapshot.empty) return res.status(404).json({ message: 'User not found' });
        const userDoc = userSnapshot.docs[0];
        const uid = userDoc.id;

        const existingAssignment = await db.collection('assignments').doc(smartlinkId).get();
        if (existingAssignment.exists) return res.status(400).json({ message: 'Smartlink already assigned' });

        let smartlinkName = smartlinkId;
        try {
            const adsterraLinks = await fetchSmartlinksFromAdsterra();
            const found = adsterraLinks.find(l => l.id == smartlinkId);
            if (found) smartlinkName = found.name;
        } catch (e) { /* ignore */ }

        await db.collection('assignments').doc(smartlinkId).set({
            userId: uid,
            userEmail: email,
            smartlinkId,
            smartlinkName,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection('users').doc(uid).update({ smartlinkId });

        res.json({ message: 'Smartlink assigned successfully' });
    } catch (error) {
        console.error('Assign error:', error);
        res.status(500).json({ message: 'Failed to assign smartlink' });
    }
});

// --- UNASSIGN Smartlink ---
app.post('/api/admin/unassign', authMiddleware('admin'), async (req, res) => {
    try {
        const { smartlinkId } = req.body;
        if (!smartlinkId) return res.status(400).json({ message: 'Smartlink ID required' });

        const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
        if (!assignmentDoc.exists) return res.status(404).json({ message: 'Assignment not found' });

        const uid = assignmentDoc.data().userId;
        await db.collection('assignments').doc(smartlinkId).delete();
        if (uid) await db.collection('users').doc(uid).update({ smartlinkId: null });

        res.json({ message: 'Smartlink unassigned successfully' });
    } catch (error) {
        console.error('Unassign error:', error);
        res.status(500).json({ message: 'Failed to unassign smartlink' });
    }
});

// --- UPDATE Permissions ---
app.patch('/api/admin/permissions', authMiddleware('admin'), async (req, res) => {
    try {
        const { userId, metric, value } = req.body;
        if (!userId || !metric || value === undefined) return res.status(400).json({ message: 'Missing fields' });

        const validMetrics = ['impressions', 'clicks', 'cpm', 'rpm', 'revenue'];
        if (!validMetrics.includes(metric)) return res.status(400).json({ message: 'Invalid metric' });

        const updateData = {};
        updateData[`permissions.${metric}`] = value;
        await db.collection('users').doc(userId).update(updateData);

        res.json({ message: 'Permission updated successfully' });
    } catch (error) {
        console.error('Permission update error:', error);
        res.status(500).json({ message: 'Failed to update permission' });
    }
});

// ============================================
// 9. USER STATS (with fallback)
// ============================================
app.get('/api/user/stats', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ message: 'User not found' });

        const userData = userDoc.data();
        const permissions = userData.permissions || {};
        const smartlinkId = userData.smartlinkId || null;

        let smartlinkData = null;
        let metrics = {};

        if (smartlinkId) {
            const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
            const smartlinkName = assignmentDoc.exists ? assignmentDoc.data().smartlinkName : smartlinkId;
            smartlinkData = { id: smartlinkId, name: smartlinkName };

            const today = new Date().toISOString().split('T')[0];
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            try {
                const rawStats = await fetchStatsFromAdsterra(sevenDaysAgo, today, smartlinkId);
                metrics = mapStatsToMetrics(rawStats);
            } catch (error) {
                console.warn('⚠️ Stats fetch failed, returning zeros');
                metrics = { impressions: 0, clicks: 0, cpm: 0, rpm: 0, revenue: 0 };
            }
        }

        res.json({
            userEmail: userData.email,
            smartlink: smartlinkData,
            permissions: permissions,
            metrics: metrics,
        });
    } catch (error) {
        console.error('User stats error:', error);
        res.status(500).json({ message: 'Failed to fetch user statistics' });
    }
});

// ============================================
// 10. ROOT / HEALTH CHECK
// ============================================
app.get('/api', (req, res) => {
    res.json({
        name: 'Lunar Metrics API',
        version: '1.0.0',
        status: 'operational',
        timestamp: new Date().toISOString(),
    });
});

module.exports = app;
