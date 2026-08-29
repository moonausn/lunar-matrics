// ============================================
// LUNAR METRICS · MASTER BACKEND
// Multiple Smartlinks per User
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
console.log(`  ADSTERRA_API_KEY: ${ADSTERRA_API_KEY ? '✅ Set' : '❌ MISSING'}`);
console.log(`  ADSTERRA_BASE_URL: ${ADSTERRA_BASE_URL || '❌ MISSING'}`);

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
// 6. ADSTERRA API HELPERS (UPDATED AUTH)
// -----------------------------
const fetchSmartlinksFromAdsterra = async () => {
    const baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com';
    const endpoint = '/publisher/smart-links.json';
    const url = `${baseUrl}${endpoint}`;

    // Try multiple auth methods
    const authMethods = [
        { name: 'query-api_key', config: { params: { api_key: ADSTERRA_API_KEY }, headers: { 'Accept': 'application/json' } } },
        { name: 'query-key', config: { params: { key: ADSTERRA_API_KEY }, headers: { 'Accept': 'application/json' } } },
        { name: 'bearer', config: { headers: { 'Authorization': `Bearer ${ADSTERRA_API_KEY}`, 'Accept': 'application/json' } } },
        { name: 'header-X-API-Key', config: { headers: { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' } } },
        { name: 'header-Api-Key', config: { headers: { 'Api-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' } } },
        { name: 'header-Token', config: { headers: { 'Authorization': `Token ${ADSTERRA_API_KEY}`, 'Accept': 'application/json' } } },
    ];

    let lastError = null;
    for (const method of authMethods) {
        try {
            console.log(`🔄 Trying auth method: ${method.name}`);
            const response = await axios.get(url, method.config);
            if (response.status === 200) {
                console.log(`✅ Success with method: ${method.name}`);
                let items = [];
                if (response.data && response.data.data && Array.isArray(response.data.data.items)) {
                    items = response.data.data.items;
                } else if (response.data && Array.isArray(response.data)) {
                    items = response.data;
                } else if (response.data && response.data.items && Array.isArray(response.data.items)) {
                    items = response.data.items;
                } else if (response.data && response.data.result && Array.isArray(response.data.result)) {
                    items = response.data.result;
                } else {
                    items = [];
                }
                console.log(`✅ Fetched ${items.length} smartlinks from Adsterra.`);
                return items.map(item => ({
                    id: item.id || item.smart_link_id || item.placement_id || String(item),
                    name: item.name || item.title || item.label || 'Unnamed',
                }));
            }
        } catch (error) {
            lastError = error;
            const errorMsg = error.response?.data?.message || error.message;
            console.warn(`❌ Method ${method.name} failed: ${errorMsg}`);
        }
    }
    console.error('❌ All authentication methods failed. Last error:', lastError?.response?.data || lastError?.message);
    throw new Error('Failed to fetch smartlinks from Adsterra');
};

const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    try {
        const baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com';
        const endpoint = '/publisher/stats.json';
        const url = `${baseUrl}${endpoint}`;
        const params = {
            api_key: ADSTERRA_API_KEY,
            from: dateFrom,
            to: dateTo,
        };
        if (smartlinkId) {
            params.placement_id = smartlinkId;
        }
        const response = await axios.get(url, { params, headers: { 'Accept': 'application/json' } });
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

// -----------------------------
// 7. AUTH ENDPOINTS
// -----------------------------
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
// 8. ADMIN ENDPOINTS (with multiple assignments)
// ============================================

// --- GET Smartlinks ---
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

        // Get assignments from Firestore (each assignment doc is keyed by smartlinkId)
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

// --- GET Users ---
app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        const users = [];
        for (const doc of usersSnapshot.docs) {
            const data = doc.data();
            let smartlinkNames = [];
            if (data.smartlinkIds && Array.isArray(data.smartlinkIds)) {
                for (const linkId of data.smartlinkIds) {
                    const assignmentDoc = await db.collection('assignments').doc(linkId).get();
                    if (assignmentDoc.exists) {
                        smartlinkNames.push(assignmentDoc.data().smartlinkName || linkId);
                    } else {
                        smartlinkNames.push(linkId);
                    }
                }
            }
            users.push({
                id: doc.id,
                email: data.email,
                role: data.role,
                permissions: data.permissions || {},
                smartlinkIds: data.smartlinkIds || [],
                smartlinkNames: smartlinkNames.join(', '), // For display in table
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
            smartlinkIds: [], // array of assigned smartlink IDs
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
        // Get user's assigned links to delete assignment docs
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData.smartlinkIds && Array.isArray(userData.smartlinkIds)) {
                const batch = db.batch();
                for (const linkId of userData.smartlinkIds) {
                    const assignmentRef = db.collection('assignments').doc(linkId);
                    batch.delete(assignmentRef);
                }
                await batch.commit();
            }
        }
        await admin.auth().deleteUser(uid);
        await db.collection('users').doc(uid).delete();
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

// --- ASSIGN Smartlink (to a user) ---
app.post('/api/admin/assign', authMiddleware('admin'), async (req, res) => {
    try {
        const { email, smartlinkId } = req.body;
        if (!email || !smartlinkId) return res.status(400).json({ message: 'Email and Smartlink ID required' });

        // Find user
        const userSnapshot = await db.collection('users').where('email', '==', email).where('role', '==', 'user').get();
        if (userSnapshot.empty) return res.status(404).json({ message: 'User not found' });
        const userDoc = userSnapshot.docs[0];
        const uid = userDoc.id;
        const userData = userDoc.data();

        // Check if smartlink is already assigned to someone else
        const existingAssignment = await db.collection('assignments').doc(smartlinkId).get();
        if (existingAssignment.exists) {
            return res.status(400).json({ message: 'Smartlink already assigned to another user' });
        }

        // Get smartlink name
        let smartlinkName = smartlinkId;
        try {
            const adsterraLinks = await fetchSmartlinksFromAdsterra();
            const found = adsterraLinks.find(l => l.id == smartlinkId);
            if (found) smartlinkName = found.name;
        } catch (e) { /* ignore */ }

        // Create assignment document
        await db.collection('assignments').doc(smartlinkId).set({
            userId: uid,
            userEmail: email,
            smartlinkId: smartlinkId,
            smartlinkName: smartlinkName,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Add to user's smartlinkIds array
        const currentIds = userData.smartlinkIds || [];
        if (!currentIds.includes(smartlinkId)) {
            currentIds.push(smartlinkId);
            await db.collection('users').doc(uid).update({ smartlinkIds: currentIds });
        }

        res.json({ message: 'Smartlink assigned successfully' });
    } catch (error) {
        console.error('Assign error:', error);
        res.status(500).json({ message: 'Failed to assign smartlink' });
    }
});

// --- UNASSIGN Smartlink (from a user) ---
app.post('/api/admin/unassign', authMiddleware('admin'), async (req, res) => {
    try {
        const { smartlinkId } = req.body;
        if (!smartlinkId) return res.status(400).json({ message: 'Smartlink ID required' });

        const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
        if (!assignmentDoc.exists) return res.status(404).json({ message: 'Assignment not found' });

        const uid = assignmentDoc.data().userId;

        // Remove assignment doc
        await db.collection('assignments').doc(smartlinkId).delete();

        // Remove from user's smartlinkIds array
        if (uid) {
            const userRef = db.collection('users').doc(uid);
            const userDoc = await userRef.get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                let ids = userData.smartlinkIds || [];
                ids = ids.filter(id => id !== smartlinkId);
                await userRef.update({ smartlinkIds: ids });
            }
        }

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
// 9. USER STATS (Multiple Smartlinks)
// ============================================
app.get('/api/user/stats', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ message: 'User not found' });

        const userData = userDoc.data();
        const permissions = userData.permissions || {};
        const smartlinkIds = userData.smartlinkIds || [];

        let smartlinks = [];
        let aggregatedMetrics = {};

        if (smartlinkIds.length > 0) {
            // For each smartlink, fetch its name and stats
            const today = new Date().toISOString().split('T')[0];
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            for (const linkId of smartlinkIds) {
                // Get link name from assignment
                const assignmentDoc = await db.collection('assignments').doc(linkId).get();
                const linkName = assignmentDoc.exists ? assignmentDoc.data().smartlinkName : linkId;

                // Fetch stats for this link
                let stats = { impressions: 0, clicks: 0, cpm: 0, rpm: 0, revenue: 0 };
                try {
                    const rawStats = await fetchStatsFromAdsterra(sevenDaysAgo, today, linkId);
                    stats = mapStatsToMetrics(rawStats);
                } catch (error) {
                    console.warn(`⚠️ Stats fetch failed for ${linkId}, returning zeros`);
                }

                smartlinks.push({
                    id: linkId,
                    name: linkName,
                    metrics: stats,
                });

                // Aggregate metrics across all links (optional)
                Object.keys(stats).forEach(key => {
                    aggregatedMetrics[key] = (aggregatedMetrics[key] || 0) + stats[key];
                });
            }
        }

        res.json({
            userEmail: userData.email,
            permissions: permissions,
            smartlinks: smartlinks,         // array of {id, name, metrics}
            aggregated: aggregatedMetrics,  // total across all links
        });
    } catch (error) {
        console.error('User stats error:', error);
        res.status(500).json({ message: 'Failed to fetch user statistics' });
    }
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

module.exports = app;
