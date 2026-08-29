// ============================================
// LUNAR METRICS · MASTER BACKEND
// ALL Smartlinks (No Filters)
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
console.log(`  ADSTERRA_BASE_URL: ${ADSTERRA_BASE_URL || '❌ MISSING (using default)'}`);
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
// 6. ADSTERRA API HELPERS (UPDATED - NO FILTERS)
// -----------------------------

/**
 * Fetch ALL Smartlinks from Adsterra
 * ✅ Removed ALL filters (status, traffic_type) to show every link.
 */
const fetchSmartlinksFromAdsterra = async () => {
    try {
        const baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com';
        const endpoint = '/publisher/smart-links.json';
        const url = `${baseUrl}${endpoint}`;

        // ✅ IMPORTANT: No params = fetch ALL smartlinks (Mainstream + Adult, Active + Inactive)
        // If you still want to filter, uncomment below lines.
        const params = {
            // status: 3,  // 3=Active, 4=Inactive (omitting fetches all)
            // traffic_type: 1, // 1=Mainstream, 2=Adult (omitting fetches all)
        };

        console.log(`🔄 Fetching ALL smartlinks from: ${url} (no filters)`);

        const response = await axios.get(url, {
            params: params,
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        // Parse response
        let items = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.items)) {
            items = response.data.data.items;
        } else if (response.data && Array.isArray(response.data)) {
            items = response.data;
        } else if (response.data && response.data.items && Array.isArray(response.data.items)) {
            items = response.data.items;
        } else {
            console.warn('Unexpected response structure:', response.data);
            items = [];
        }

        console.log(`✅ Fetched ${items.length} smartlinks from Adsterra.`);

        return items.map(item => ({
            id: item.id || item.smart_link_id || item.placement_id || String(item),
            name: item.name || item.title || item.label || 'Unnamed',
        }));
    } catch (error) {
        console.error('Adsterra Smartlinks fetch error:', error.response?.data || error.message);
        throw new Error('Failed to fetch smartlinks from Adsterra');
    }
};

/**
 * Fetch statistics for a specific smartlink.
 */
const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    try {
        const baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com';
        // ⚠️ CHANGE THIS ENDPOINT according to actual Adsterra stats API
        const endpoint = '/publisher/stats.json';
        const url = `${baseUrl}${endpoint}`;

        const params = {
            from: dateFrom,
            to: dateTo,
        };
        if (smartlinkId) {
            params.placement_id = smartlinkId;
        }

        const response = await axios.get(url, {
            params: params,
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        let statsData = response.data;
        if (statsData.data && statsData.data.items) {
            statsData = statsData.data.items;
        }
        if (Array.isArray(statsData)) {
            if (smartlinkId) {
                const found = statsData.find(item =>
                    (item.placement_id && item.placement_id == smartlinkId) ||
                    (item.smartlink_id && item.smartlink_id == smartlinkId)
                );
                return found || {};
            }
            return statsData.length > 0 ? statsData[0] : {};
        }
        return statsData || {};
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
// 8. ADMIN ENDPOINTS
// ============================================

app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    try {
        let adsterraLinks = [];
        try {
            adsterraLinks = await fetchSmartlinksFromAdsterra();
        } catch (error) {
            console.warn('⚠️ Adsterra API failed, using fallback mock data.');
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
        if (!uid) return res.status(400).json({ message: 'User ID required' });

        await admin.auth().deleteUser(uid);
        await db.collection('users').doc(uid).delete();
        const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
        const batch = db.batch();
        assignmentsSnapshot.forEach(doc => batch.delete(doc.ref));
        await batch.commit();

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        if (error.code === 'auth/user-not-found') {
            try {
                await db.collection('users').doc(req.params.uid).delete();
                return res.json({ message: 'User deleted from Firestore (auth user not found)' });
            } catch (e) {
                return res.status(500).json({ message: 'Failed to delete user from Firestore' });
            }
        }
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
// 9. USER STATS
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
