// ============================================
// LUNAR METRICS · MASTER BACKEND (v1.4.0)
// ============================================
// ORIGINAL:
//   - Auth (admin/user login + signup)
//   - Adsterra smartlinks fetch
//   - Admin users / links / permissions / assign / unassign
//   - User stats / analytics
//   - Goals (CRUD)
//   - Leaderboard
//   - Chart data (admin/user)
//
// v1.3.0:
//   ✨ SELF-SERVICE LINK CLAIMING
//   ✨ WITHDRAWAL SYSTEM (with rejection reason)
//   ✨ LIVE CHAT
//
// v1.4.0 (NEW):
//   💰 BALANCE ENDPOINT — total earned, withdrawn, pending, available
//   🔒 WITHDRAWAL BALANCE VALIDATION — reject if insufficient funds
//   🪙 CRYPTO SPLIT — binance_uid (internal) vs usdt_bep20 (on-chain)
//   🔧 ADMIN WITHDRAWAL FETCH — better error handling + logging
//   💬 CHAT ENDPOINTS — batch enrichment + robust error handling
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
    JWT_SECRET,
    BALANCE_LOOKBACK_DAYS, // OPTIONAL — defaults to 365
} = process.env;

console.log('✅ Environment loaded:');
console.log(`  FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID || '❌ MISSING'}`);
console.log(`  ADSTERRA_API_KEY: ${ADSTERRA_API_KEY ? '✅ Set' : '❌ MISSING'}`);
console.log(`  ADSTERRA_BASE_URL: ${ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/'}`);
console.log(`  JWT_SECRET: ${JWT_SECRET ? '✅ Set' : '❌ MISSING'}`);
console.log(`  BALANCE_LOOKBACK_DAYS: ${BALANCE_LOOKBACK_DAYS || '365 (default)'}`);

if (!FIREBASE_WEB_API_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !ADSTERRA_API_KEY || !JWT_SECRET) {
    console.error('❌ Missing required environment variables. Exiting.');
    process.exit(1);
}

const BALANCE_PERIOD_DAYS = parseInt(BALANCE_LOOKBACK_DAYS) || 365;

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

// ----- ADSTERRA TEST ENDPOINT -----
app.get('/api/test-adsterra', async (req, res) => {
    try {
        let baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/';
        if (!baseUrl.endsWith('/')) baseUrl += '/';
        const url = `${baseUrl}smart-links.json`;

        console.log('🔄 Testing Adsterra API with X-API-Key header:', url);
        const response = await axios.get(url, {
            headers: {
                'X-API-Key': ADSTERRA_API_KEY,
                'Accept': 'application/json'
            },
            timeout: 15000,
        });

        let items = [];
        if (response.data?.data?.items && Array.isArray(response.data.data.items)) items = response.data.data.items;
        else if (Array.isArray(response.data)) items = response.data;
        else if (response.data?.items && Array.isArray(response.data.items)) items = response.data.items;

        const sample = items.slice(0, 5).map(i => ({
            id: i.id || i.smart_link_id || i.placement_id,
            title: i.title,
            alias: i.alias,
            url: i.url,
            allKeys: Object.keys(i),
        }));

        res.json({ success: true, count: items.length, sample, fullData: response.data });
    } catch (error) {
        console.error('❌ Test Adsterra error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message,
            status: error.response?.status,
            message: 'Adsterra API call failed. Check your API key and base URL.',
        });
    }
});

// -----------------------------
// 4. AUTH MIDDLEWARE
// -----------------------------
const authMiddleware = (requiredRole = null) => {
    return async (req, res, next) => {
        try {
            const token = req.headers.authorization?.split('Bearer ')[1];
            if (!token) return res.status(401).json({ message: 'Unauthorized: No token provided' });

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
// 6. SHARED UTILITY HELPERS
// -----------------------------
const safeDateToISO = (ts) => ts ? ts.toDate().toISOString() : null;
const getLimit = (req, def = 100, max = 500) => {
    const n = parseInt(req.query.limit) || def;
    return Math.min(Math.max(n, 1), max);
};

// -----------------------------
// 7. ADSTERRA API HELPERS
// -----------------------------
const fetchSmartlinksFromAdsterra = async () => {
    let baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/';
    if (!baseUrl.endsWith('/')) baseUrl += '/';
    const url = `${baseUrl}smart-links.json`;

    console.log(`🔄 Fetching real smartlinks from: ${url} using X-API-Key`);

    try {
        const response = await axios.get(url, {
            headers: { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' },
            timeout: 15000,
        });

        if (response.status !== 200) throw new Error(`Adsterra returned status ${response.status}`);

        let items = [];
        if (response.data?.data?.items && Array.isArray(response.data.data.items)) items = response.data.data.items;
        else if (Array.isArray(response.data)) items = response.data;
        else if (response.data?.items && Array.isArray(response.data.items)) items = response.data.items;
        else if (response.data?.result && Array.isArray(response.data.result)) items = response.data.result;
        else throw new Error('Unexpected response structure from Adsterra');

        const mapped = items.map(item => {
            let name = item.alias || item.name || item.title || item.label || item.smartlink_name || '';
            if (!name) {
                for (const key of Object.keys(item)) {
                    if (key.toLowerCase().includes('name') && typeof item[key] === 'string') {
                        name = item[key];
                        break;
                    }
                }
            }
            if (!name) name = item.id || item.smart_link_id || item.placement_id || 'Unnamed';

            return {
                id: String(item.id || item.smart_link_id || item.placement_id || item),
                name,
                url: item.url || '',
            };
        });

        console.log(`✅ Fetched ${mapped.length} smartlinks with names and URLs`);
        return mapped;
    } catch (error) {
        console.error('❌ Adsterra API error:', error.response?.data || error.message);
        throw new Error(`Failed to fetch real data from Adsterra: ${error.response?.data?.message || error.message}`);
    }
};

const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    try {
        let baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/';
        if (!baseUrl.endsWith('/')) baseUrl += '/';
        const url = `${baseUrl}stats.json`;

        const params = { from: dateFrom, to: dateTo };
        if (smartlinkId) params.placement_id = smartlinkId;

        const response = await axios.get(url, {
            params,
            headers: { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' },
            timeout: 15000,
        });

        let statsData = response.data;
        if (statsData.data?.items) statsData = statsData.data.items;

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

const fetchDailyStatsForLink = async (smartlinkId, days = 7) => {
    const dailyData = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const nextDay = new Date(d);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDateStr = nextDay.toISOString().split('T')[0];

        const stats = await fetchStatsFromAdsterra(dateStr, nextDateStr, smartlinkId);
        dailyData.push({
            date: dateStr,
            impressions: stats.impressions || 0,
            clicks: stats.clicks || 0,
            revenue: stats.revenue || 0,
        });
    }
    return dailyData;
};

const mapStatsToMetrics = (rawStats) => ({
    impressions: rawStats.impressions || 0,
    clicks: rawStats.clicks || 0,
    cpm: rawStats.cpm || 0,
    rpm: rawStats.rpm || 0,
    revenue: rawStats.revenue || 0,
});

// -----------------------------
// 8. AUTH ENDPOINTS
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

app.post('/api/auth/user-signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email, and password are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const userRecord = await admin.auth().createUser({
            email, password, emailVerified: false, disabled: false, displayName: name,
        });

        await db.collection('users').doc(userRecord.uid).set({
            email,
            displayName: name,
            role: 'user',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            permissions: { impressions: true, clicks: true, cpm: true, rpm: true, revenue: true },
            smartlinkId: null,
            currencyPreference: 'USD',
        });

        res.status(201).json({
            message: 'User account created successfully! You can now log in.',
            uid: userRecord.uid,
        });
    } catch (error) {
        console.error('Signup error:', error);
        if (error.code === 'auth/email-already-exists') {
            return res.status(400).json({ message: 'Email already exists. Please use a different email.' });
        }
        res.status(500).json({ message: 'Failed to create account. Please try again.' });
    }
});

// -----------------------------
// 9. ADMIN ENDPOINTS (Users / Links)
// -----------------------------
app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    try {
        const adsterraLinks = await fetchSmartlinksFromAdsterra();

        const assignmentsSnapshot = await db.collection('assignments').get();
        const assignments = {};
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            assignments[data.smartlinkId] = {
                userEmail: data.userEmail,
                userId: data.userId,
                smartlinkName: data.smartlinkName,
                claimedBySelf: data.claimedBySelf || false,
            };
        });

        const smartlinks = adsterraLinks.map(link => {
            const assigned = assignments[link.id];
            return {
                ...link,
                status: assigned ? 'assigned' : 'available',
                assignedTo: assigned ? assigned.userEmail : null,
                assignedUserId: assigned ? assigned.userId : null,
                claimedBySelf: assigned ? assigned.claimedBySelf : false,
                url: link.url || '',
            };
        });

        res.json(smartlinks);
    } catch (error) {
        console.error('Smartlinks fetch error:', error.message);
        res.status(500).json({
            message: 'Failed to fetch real data from Adsterra',
            error: error.message,
        });
    }
});

app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    try {
        const { search, filter } = req.query;
        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        let users = [];

        for (const doc of usersSnapshot.docs) {
            const data = doc.data();
            const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', doc.id).get();
            const smartlinkNames = [];
            assignmentsSnapshot.forEach(assignmentDoc => {
                const assignmentData = assignmentDoc.data();
                smartlinkNames.push(assignmentData.smartlinkName || assignmentData.smartlinkId);
            });

            users.push({
                id: doc.id,
                email: data.email,
                displayName: data.displayName || '',
                role: data.role,
                permissions: data.permissions || {},
                smartlinkId: data.smartlinkId || null,
                smartlinkName: smartlinkNames.length > 0 ? smartlinkNames.join(', ') : null,
                assignedLinks: smartlinkNames,
                currencyPreference: data.currencyPreference || 'USD',
            });
        }

        if (search) {
            const s = search.toLowerCase();
            users = users.filter(u =>
                u.email.toLowerCase().includes(s) ||
                (u.displayName && u.displayName.toLowerCase().includes(s)) ||
                (u.smartlinkName && u.smartlinkName.toLowerCase().includes(s)) ||
                u.id.toLowerCase().includes(s)
            );
        }

        if (filter === 'assigned') {
            users = users.filter(u => u.smartlinkName && u.smartlinkName !== '—' && u.smartlinkName !== null);
        } else if (filter === 'unassigned') {
            users = users.filter(u => !u.smartlinkName || u.smartlinkName === '—' || u.smartlinkName === null);
        }

        res.json(users);
    } catch (error) {
        console.error('Users fetch error:', error);
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

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
            currencyPreference: 'USD',
        });

        res.status(201).json({ message: 'User created successfully', uid: userRecord.uid });
    } catch (error) {
        console.error('Create user error:', error);
        if (error.code === 'auth/email-already-exists') return res.status(400).json({ message: 'Email already exists' });
        res.status(500).json({ message: 'Failed to create user' });
    }
});

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

        res.json({ message: 'User deleted successfully. Their links are now available.' });
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

app.post('/api/admin/assign', authMiddleware('admin'), async (req, res) => {
    try {
        const { email, smartlinkId } = req.body;
        if (!email || !smartlinkId) return res.status(400).json({ message: 'Email and Smartlink ID required' });

        const userSnapshot = await db.collection('users').where('email', '==', email).where('role', '==', 'user').get();
        if (userSnapshot.empty) return res.status(404).json({ message: 'User not found' });
        const userDoc = userSnapshot.docs[0];
        const uid = userDoc.id;

        let linkName = smartlinkId;
        try {
            const adsterraLinks = await fetchSmartlinksFromAdsterra();
            const found = adsterraLinks.find(l => l.id == smartlinkId);
            if (found && found.name) linkName = found.name;
        } catch (err) {
            console.warn(`⚠️ Could not fetch name from Adsterra: ${err.message}`);
        }

        await db.runTransaction(async (transaction) => {
            const assignmentRef = db.collection('assignments').doc(String(smartlinkId));
            const assignmentDoc = await transaction.get(assignmentRef);
            if (assignmentDoc.exists) throw new Error('ALREADY_ASSIGNED');

            transaction.set(assignmentRef, {
                userId: uid,
                userEmail: email,
                smartlinkId: String(smartlinkId),
                smartlinkName: linkName,
                assignedAt: admin.firestore.FieldValue.serverTimestamp(),
                claimedBySelf: false,
            });
            transaction.update(db.collection('users').doc(uid), { smartlinkId: String(smartlinkId) });
        });

        res.json({ message: `Link "${linkName}" assigned successfully` });
    } catch (error) {
        if (error.message === 'ALREADY_ASSIGNED') {
            return res.status(400).json({ message: 'Smartlink already assigned' });
        }
        console.error('Assign error:', error);
        res.status(500).json({ message: 'Failed to assign link' });
    }
});

app.post('/api/admin/unassign', authMiddleware('admin'), async (req, res) => {
    try {
        const { smartlinkId } = req.body;
        if (!smartlinkId) return res.status(400).json({ message: 'Smartlink ID required' });

        const assignmentDoc = await db.collection('assignments').doc(String(smartlinkId)).get();
        if (!assignmentDoc.exists) return res.status(404).json({ message: 'Assignment not found' });

        const uid = assignmentDoc.data().userId;
        await db.collection('assignments').doc(String(smartlinkId)).delete();

        const remainingAssignments = await db.collection('assignments').where('userId', '==', uid).get();
        if (remainingAssignments.empty) {
            await db.collection('users').doc(uid).update({ smartlinkId: null });
        } else {
            const nextId = remainingAssignments.docs[0].data().smartlinkId;
            await db.collection('users').doc(uid).update({ smartlinkId: nextId });
        }

        res.json({ message: 'Link released back to available pool.' });
    } catch (error) {
        console.error('Unassign error:', error);
        res.status(500).json({ message: 'Failed to unassign link' });
    }
});

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

app.get('/api/admin/fix-names', authMiddleware('admin'), async (req, res) => {
    try {
        console.log('🔄 Starting name fix for all assignments...');
        const adsterraLinks = await fetchSmartlinksFromAdsterra();
        const nameMap = {};
        adsterraLinks.forEach(link => { nameMap[link.id] = link.name; });

        const assignmentsSnapshot = await db.collection('assignments').get();
        let updatedCount = 0;
        let notFoundCount = 0;
        const batch = db.batch();

        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            const realName = nameMap[data.smartlinkId];
            if (realName && realName !== data.smartlinkName) {
                batch.update(doc.ref, { smartlinkName: realName });
                updatedCount++;
            } else if (!realName) {
                notFoundCount++;
            }
        });

        await batch.commit();
        res.json({
            message: 'Assignment names fixed successfully!',
            updated: updatedCount,
            notFound: notFoundCount,
            total: assignmentsSnapshot.size,
        });
    } catch (error) {
        console.error('Fix names error:', error);
        res.status(500).json({ message: 'Failed to fix names', error: error.message });
    }
});

// ================================================================
// 10. USER — AVAILABLE LINKS + CLAIM
// ================================================================
app.get('/api/user/available-links', authMiddleware('user'), async (req, res) => {
    try {
        const adsterraLinks = await fetchSmartlinksFromAdsterra();

        const assignmentsSnapshot = await db.collection('assignments').get();
        const claimedIds = new Set();
        assignmentsSnapshot.forEach(doc => claimedIds.add(doc.data().smartlinkId));

        const available = adsterraLinks
            .filter(link => !claimedIds.has(String(link.id)))
            .map(link => ({ id: link.id, name: link.name, url: link.url }));

        res.json({ links: available, count: available.length });
    } catch (error) {
        console.error('Available links error:', error);
        res.status(500).json({ message: 'Failed to fetch available links', error: error.message });
    }
});

app.post('/api/user/claim-link', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const { smartlinkId } = req.body;

        if (!smartlinkId) return res.status(400).json({ message: 'Smartlink ID required' });

        const adsterraLinks = await fetchSmartlinksFromAdsterra();
        const link = adsterraLinks.find(l => String(l.id) === String(smartlinkId));
        if (!link) return res.status(404).json({ message: 'Link not found in Adsterra pool.' });

        await db.runTransaction(async (transaction) => {
            const assignmentRef = db.collection('assignments').doc(String(smartlinkId));
            const userRef = db.collection('users').doc(uid);

            const assignmentDoc = await transaction.get(assignmentRef);
            const userDoc = await transaction.get(userRef);

            if (assignmentDoc.exists) throw new Error('ALREADY_CLAIMED');
            if (!userDoc.exists) throw new Error('USER_NOT_FOUND');

            transaction.set(assignmentRef, {
                userId: uid,
                userEmail: email,
                smartlinkId: String(smartlinkId),
                smartlinkName: link.name,
                assignedAt: admin.firestore.FieldValue.serverTimestamp(),
                claimedBySelf: true,
            });
            transaction.update(userRef, { smartlinkId: String(smartlinkId) });
        });

        res.json({
            message: `Link "${link.name}" claimed successfully!`,
            link: { id: link.id, name: link.name, url: link.url },
        });
    } catch (error) {
        if (error.message === 'ALREADY_CLAIMED') {
            return res.status(409).json({ message: 'This link has already been claimed by another user.' });
        }
        if (error.message === 'USER_NOT_FOUND') {
            return res.status(404).json({ message: 'User not found.' });
        }
        console.error('Claim link error:', error);
        res.status(500).json({ message: 'Failed to claim link', error: error.message });
    }
});

// ================================================================
// 11. USER STATS + ANALYTICS
// ================================================================
app.get('/api/user/stats', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ message: 'User not found' });

        const userData = userDoc.data();
        const permissions = userData.permissions || {};
        const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();

        const smartlinks = [];
        if (!assignmentsSnapshot.empty) {
            const today = new Date().toISOString().split('T')[0];
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            for (const doc of assignmentsSnapshot.docs) {
                const assignmentData = doc.data();
                const smartlinkId = assignmentData.smartlinkId;
                const smartlinkName = assignmentData.smartlinkName || smartlinkId;

                try {
                    const rawStats = await fetchStatsFromAdsterra(sevenDaysAgo, today, smartlinkId);
                    const metrics = mapStatsToMetrics(rawStats);
                    smartlinks.push({ id: smartlinkId, name: smartlinkName, metrics });
                } catch (error) {
                    console.warn(`⚠️ Failed to fetch stats for link ${smartlinkId}:`, error.message);
                    smartlinks.push({
                        id: smartlinkId,
                        name: smartlinkName,
                        metrics: { impressions: 0, clicks: 0, cpm: 0, rpm: 0, revenue: 0 },
                    });
                }
            }
        }

        res.json({ userEmail: userData.email, permissions, smartlinks });
    } catch (error) {
        console.error('User stats error:', error);
        res.status(500).json({ message: 'Failed to fetch user statistics' });
    }
});

app.get('/api/user/analytics', authMiddleware('user'), async (req, res) => {
    try {
        const currentUid = req.user.uid;
        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();

        const otherUsers = [];
        for (const doc of usersSnapshot.docs) {
            if (doc.id === currentUid) continue;
            const data = doc.data();
            otherUsers.push({
                uid: doc.id,
                email: data.email,
                displayName: data.displayName || data.email.split('@')[0] || 'User',
            });
        }

        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const analytics = [];
        for (const user of otherUsers) {
            const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', user.uid).get();
            let totalClicks = 0;

            if (!assignmentsSnapshot.empty) {
                for (const doc of assignmentsSnapshot.docs) {
                    const assignmentData = doc.data();
                    const smartlinkId = assignmentData.smartlinkId;
                    try {
                        const rawStats = await fetchStatsFromAdsterra(today, tomorrow, smartlinkId);
                        totalClicks += rawStats.clicks || 0;
                    } catch (error) {
                        console.warn(`⚠️ Analytics stats failed for link ${smartlinkId}:`, error.message);
                    }
                }
            }

            analytics.push({ displayName: user.displayName, email: user.email, totalClicks });
        }

        analytics.sort((a, b) => b.totalClicks - a.totalClicks);
        res.json({ users: analytics, updatedAt: new Date().toISOString() });
    } catch (error) {
        console.error('User analytics error:', error);
        res.status(500).json({ message: 'Failed to fetch user analytics' });
    }
});

// ================================================================
// 12. USER GOALS
// ================================================================
const getUserAggregatedStats = async (uid, dateFrom, dateTo) => {
    const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
    if (assignmentsSnapshot.empty) {
        return { impressions: 0, clicks: 0, revenue: 0, cpm: 0, rpm: 0 };
    }

    let totalImpressions = 0, totalClicks = 0, totalRevenue = 0, totalCpm = 0, totalRpm = 0, count = 0;

    for (const doc of assignmentsSnapshot.docs) {
        const data = doc.data();
        const smartlinkId = data.smartlinkId;
        try {
            const rawStats = await fetchStatsFromAdsterra(dateFrom, dateTo, smartlinkId);
            totalImpressions += rawStats.impressions || 0;
            totalClicks += rawStats.clicks || 0;
            totalRevenue += rawStats.revenue || 0;
            totalCpm += rawStats.cpm || 0;
            totalRpm += rawStats.rpm || 0;
            count++;
        } catch (error) {
            console.warn(`⚠️ Goal agg stats failed for link ${smartlinkId}:`, error.message);
        }
    }

    return {
        impressions: totalImpressions,
        clicks: totalClicks,
        revenue: totalRevenue,
        cpm: count > 0 ? totalCpm / count : 0,
        rpm: count > 0 ? totalRpm / count : 0,
    };
};

app.get('/api/user/goals', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const goalsSnapshot = await db.collection('users').doc(uid).collection('goals').get();
        if (goalsSnapshot.empty) return res.json({ goals: [] });

        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const currentStats = await getUserAggregatedStats(uid, thirtyDaysAgo, today);

        const goals = [];
        goalsSnapshot.forEach(doc => {
            const data = doc.data();
            let current = 0;
            switch (data.type) {
                case 'revenue': current = currentStats.revenue || 0; break;
                case 'clicks': current = currentStats.clicks || 0; break;
                case 'impressions': current = currentStats.impressions || 0; break;
                case 'rpm': current = currentStats.rpm || 0; break;
            }
            const target = data.target || 1;
            const progress = target > 0 ? Math.min((current / target) * 100, 100) : 0;

            goals.push({
                id: doc.id,
                type: data.type,
                title: data.title || data.type.charAt(0).toUpperCase() + data.type.slice(1),
                target: data.target,
                current,
                progress,
                deadline: data.deadline || null,
                createdAt: safeDateToISO(data.createdAt) || new Date().toISOString(),
                updatedAt: safeDateToISO(data.updatedAt) || new Date().toISOString(),
            });
        });

        res.json({ goals });
    } catch (error) {
        console.error('Get goals error:', error);
        res.status(500).json({ message: 'Failed to fetch goals', error: error.message });
    }
});

app.post('/api/user/goals', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const { type, target, deadline } = req.body;

        if (!type || !target || target <= 0) return res.status(400).json({ message: 'Type and valid target are required.' });
        if (!['revenue', 'clicks', 'impressions', 'rpm'].includes(type)) {
            return res.status(400).json({ message: 'Invalid goal type.' });
        }

        const goalData = {
            type,
            target: parseFloat(target),
            deadline: deadline || null,
            title: type.charAt(0).toUpperCase() + type.slice(1),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await db.collection('users').doc(uid).collection('goals').add(goalData);
        res.status(201).json({ message: 'Goal created successfully!', goalId: docRef.id });
    } catch (error) {
        console.error('Create goal error:', error);
        res.status(500).json({ message: 'Failed to create goal', error: error.message });
    }
});

app.put('/api/user/goals/:goalId', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const { goalId } = req.params;
        const { type, target, deadline } = req.body;

        if (!goalId) return res.status(400).json({ message: 'Goal ID required.' });
        if (!type || !target || target <= 0) return res.status(400).json({ message: 'Type and valid target are required.' });
        if (!['revenue', 'clicks', 'impressions', 'rpm'].includes(type)) {
            return res.status(400).json({ message: 'Invalid goal type.' });
        }

        const goalRef = db.collection('users').doc(uid).collection('goals').doc(goalId);
        const goalDoc = await goalRef.get();
        if (!goalDoc.exists) return res.status(404).json({ message: 'Goal not found.' });

        await goalRef.update({
            type,
            target: parseFloat(target),
            deadline: deadline || null,
            title: type.charAt(0).toUpperCase() + type.slice(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.json({ message: 'Goal updated successfully!' });
    } catch (error) {
        console.error('Update goal error:', error);
        res.status(500).json({ message: 'Failed to update goal', error: error.message });
    }
});

app.delete('/api/user/goals/:goalId', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const { goalId } = req.params;
        if (!goalId) return res.status(400).json({ message: 'Goal ID required.' });

        const goalRef = db.collection('users').doc(uid).collection('goals').doc(goalId);
        const goalDoc = await goalRef.get();
        if (!goalDoc.exists) return res.status(404).json({ message: 'Goal not found.' });

        await goalRef.delete();
        res.json({ message: 'Goal deleted successfully!' });
    } catch (error) {
        console.error('Delete goal error:', error);
        res.status(500).json({ message: 'Failed to delete goal', error: error.message });
    }
});

// ================================================================
// 13. NEW (v1.4.0): USER BALANCE
// ================================================================

/**
 * Core balance calculation helper.
 * Balance = TotalEarned - ApprovedWithdrawn - PendingWithdrawn - ProcessingWithdrawn
 */
const getUserBalance = async (uid, days = BALANCE_PERIOD_DAYS) => {
    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Total earned (revenue from all assigned links)
    const stats = await getUserAggregatedStats(uid, fromDate, today);
    const totalEarned = stats.revenue || 0;

    // Total withdrawals (all statuses)
    const withdrawalsSnapshot = await db.collection('withdrawalRequests')
        .where('userId', '==', uid)
        .get();

    let totalWithdrawn = 0;      // approved (money already sent)
    let totalPending = 0;        // pending (waiting for admin)
    let totalProcessing = 0;     // processing (admin approved, sending money)

    withdrawalsSnapshot.forEach(doc => {
        const d = doc.data();
        const amt = parseFloat(d.amount) || 0;
        if (d.status === 'approved') totalWithdrawn += amt;
        else if (d.status === 'pending') totalPending += amt;
        else if (d.status === 'processing') totalProcessing += amt;
    });

    const lockedInRequests = totalPending + totalProcessing;
    const availableBalance = Math.max(0, totalEarned - totalWithdrawn - lockedInRequests);

    return {
        totalEarned: Math.round(totalEarned * 100) / 100,
        totalWithdrawn: Math.round(totalWithdrawn * 100) / 100,
        totalPending: Math.round(totalPending * 100) / 100,
        totalProcessing: Math.round(totalProcessing * 100) / 100,
        lockedInRequests: Math.round(lockedInRequests * 100) / 100,
        availableBalance: Math.round(availableBalance * 100) / 100,
        currency: 'USD',
        periodDays: days,
        periodFrom: fromDate,
        periodTo: today,
        calculatedAt: new Date().toISOString(),
    };
};

/**
 * GET /api/user/balance
 * Returns user's current balance breakdown.
 */
app.get('/api/user/balance', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const days = parseInt(req.query.days) || BALANCE_PERIOD_DAYS;

        const balance = await getUserBalance(uid, days);
        res.json(balance);
    } catch (error) {
        console.error('Balance fetch error:', error);
        res.status(500).json({
            message: 'Failed to fetch balance. Please try again.',
            error: error.message,
        });
    }
});

// ================================================================
// 14. USER — WITHDRAWAL REQUESTS (with balance validation)
// ================================================================

// Crypto methods are SPLIT now:
//   - binance_uid  → internal transfer, needs UID only
//   - usdt_bep20   → on-chain transfer, needs wallet address only
// Legacy 'crypto' method kept for OLD database records only (validation still handles it).
const WITHDRAWAL_METHODS = ['jazzcash', 'easypaisa', 'bank', 'binance_uid', 'usdt_bep20'];
const MIN_WITHDRAWAL_USD = 1;

function validateWithdrawalPayload(body) {
    const { amount, method } = body;

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return 'Amount must be greater than 0.';
    if (amt < MIN_WITHDRAWAL_USD) return `Minimum withdrawal amount is $${MIN_WITHDRAWAL_USD}.`;
    if (!WITHDRAWAL_METHODS.includes(method)) return 'Invalid withdrawal method.';

    if (method === 'jazzcash' || method === 'easypaisa') {
        if (!body.accountName || !String(body.accountName).trim()) return 'Account holder name is required.';
        if (!body.accountNumber || !String(body.accountNumber).trim()) return 'Account number is required.';
    }
    if (method === 'bank') {
        if (!body.accountName || !String(body.accountName).trim()) return 'Account holder name is required.';
        if (!body.iban || !String(body.iban).trim()) return 'IBAN is required.';
    }
    if (method === 'binance_uid') {
        if (!body.binanceUid || !String(body.binanceUid).trim()) return 'Binance UID is required.';
    }
    if (method === 'usdt_bep20') {
        if (!body.usdtAddress || !String(body.usdtAddress).trim()) return 'USDT (BEP20) address is required.';
    }

    return null;
}

app.post('/api/user/withdrawal-request', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;

        // 1. Validate payload
        const validationError = validateWithdrawalPayload(req.body);
        if (validationError) return res.status(400).json({ message: validationError });

        // 2. Fetch user
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ message: 'User not found.' });
        const userData = userDoc.data();

        // 3. Balance check (CRITICAL FIX)
        const requestedAmount = parseFloat(req.body.amount);
        let balance;
        try {
            balance = await getUserBalance(uid);
        } catch (balanceError) {
            console.error('⚠️ Balance check failed:', balanceError.message);
            return res.status(500).json({
                message: 'Unable to verify your balance right now. Please try again in a moment.',
            });
        }

        if (balance.availableBalance <= 0) {
            return res.status(400).json({
                message: `You have no available balance to withdraw. Available: $${balance.availableBalance.toFixed(2)}.`,
                availableBalance: balance.availableBalance,
                totalEarned: balance.totalEarned,
                lockedInRequests: balance.lockedInRequests,
            });
        }

        if (requestedAmount > balance.availableBalance) {
            return res.status(400).json({
                message: `Insufficient balance. You requested $${requestedAmount.toFixed(2)} but only $${balance.availableBalance.toFixed(2)} is available.`,
                availableBalance: balance.availableBalance,
                totalEarned: balance.totalEarned,
                lockedInRequests: balance.lockedInRequests,
                requestedAmount,
            });
        }

        const { amount, method, accountName, accountNumber, iban, binanceUid, usdtAddress } = req.body;

        const requestData = {
            userId: uid,
            userEmail: email,
            userName: userData.displayName || email.split('@')[0] || 'User',
            amount: parseFloat(amount),
            method,
            status: 'pending',
            rejectionReason: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedBy: null,
            processedAt: null,
            balanceAtRequest: balance.availableBalance, // audit trail
        };

        // Method-specific fields
        if (method === 'jazzcash' || method === 'easypaisa') {
            requestData.accountName = String(accountName).trim();
            requestData.accountNumber = String(accountNumber).trim();
        } else if (method === 'bank') {
            requestData.accountName = String(accountName).trim();
            requestData.iban = String(iban).trim();
            if (accountNumber) requestData.accountNumber = String(accountNumber).trim();
            if (req.body.bankName) requestData.bankName = String(req.body.bankName).trim();
        } else if (method === 'binance_uid') {
            requestData.binanceUid = String(binanceUid).trim();
            requestData.cryptoType = 'binance_internal';
        } else if (method === 'usdt_bep20') {
            requestData.usdtAddress = String(usdtAddress).trim();
            requestData.cryptoType = 'usdt_bep20_onchain';
            requestData.cryptoNetwork = 'BEP20';
        }

        const docRef = await db.collection('withdrawalRequests').add(requestData);

        res.status(201).json({
            message: 'Withdrawal request submitted successfully! Admin will review it soon.',
            requestId: docRef.id,
            newAvailableBalance: Math.round((balance.availableBalance - requestedAmount) * 100) / 100,
        });
    } catch (error) {
        console.error('Create withdrawal error:', error);
        res.status(500).json({ message: 'Failed to create withdrawal request', error: error.message });
    }
});

app.get('/api/user/withdrawal-requests', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const limit = getLimit(req, 100, 200);

        const snapshot = await db.collection('withdrawalRequests')
            .where('userId', '==', uid)
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            requests.push({
                id: doc.id,
                amount: d.amount,
                method: d.method,
                status: d.status,
                rejectionReason: d.rejectionReason || null,
                accountName: d.accountName || null,
                accountNumber: d.accountNumber || null,
                iban: d.iban || null,
                bankName: d.bankName || null,
                binanceUid: d.binanceUid || null,
                usdtAddress: d.usdtAddress || null,
                cryptoNetwork: d.cryptoNetwork || null,
                cryptoType: d.cryptoType || null,
                createdAt: safeDateToISO(d.createdAt),
                updatedAt: safeDateToISO(d.updatedAt),
                processedAt: safeDateToISO(d.processedAt),
                processedBy: d.processedBy || null,
            });
        });

        requests.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bt - at;
        });

        res.json({ requests: requests.slice(0, limit), count: requests.length });
    } catch (error) {
        console.error('Fetch withdrawal requests error:', error);
        res.status(500).json({ message: 'Failed to fetch withdrawal requests', error: error.message });
    }
});

// ================================================================
// 15. ADMIN — WITHDRAWAL MANAGEMENT (v1.4.0 improved)
// ================================================================

/**
 * GET /api/admin/withdrawal-requests?status=pending|processing|approved|rejected|all
 */
app.get('/api/admin/withdrawal-requests', authMiddleware('admin'), async (req, res) => {
    try {
        const status = req.query.status || 'all';
        const limit = getLimit(req, 200, 500);

        console.log(`🔄 [ADMIN WITHDRAWALS] Fetching. Status filter: ${status}`);

        // Fetch ALL, filter in memory to avoid missing index / query issues
        const snapshot = await db.collection('withdrawalRequests').get();

        const requests = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            requests.push({
                id: doc.id,
                userId: d.userId || null,
                userEmail: d.userEmail || '—',
                userName: d.userName || '—',
                amount: d.amount || 0,
                method: d.method || '—',
                status: d.status || 'pending',
                rejectionReason: d.rejectionReason || null,
                accountName: d.accountName || null,
                accountNumber: d.accountNumber || null,
                iban: d.iban || null,
                bankName: d.bankName || null,
                binanceUid: d.binanceUid || null,
                usdtAddress: d.usdtAddress || null,
                cryptoNetwork: d.cryptoNetwork || null,
                cryptoType: d.cryptoType || null,
                createdAt: safeDateToISO(d.createdAt),
                updatedAt: safeDateToISO(d.updatedAt),
                processedAt: safeDateToISO(d.processedAt),
                processedBy: d.processedBy || null,
            });
        });

        // Filter by status (in memory)
        const filtered = status === 'all'
            ? requests
            : requests.filter(r => r.status === status);

        // Sort newest first
        filtered.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bt - at;
        });

        console.log(`✅ [ADMIN WITHDRAWALS] Returning ${filtered.length} of ${requests.length} total (filter=${status})`);

        res.json({
            requests: filtered.slice(0, limit),
            count: filtered.length,
            totalCount: requests.length,
            filter: status,
        });
    } catch (error) {
        console.error('❌ [ADMIN WITHDRAWALS] Fetch error:', error);
        res.status(500).json({
            message: 'Failed to fetch withdrawal requests',
            error: error.message,
        });
    }
});

/**
 * PATCH /api/admin/withdrawal-requests/:id
 * Body: { status, rejectionReason? }
 * rejectionReason REQUIRED when status = 'rejected'
 */
app.patch('/api/admin/withdrawal-requests/:id', authMiddleware('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status, rejectionReason } = req.body;

        if (!id) return res.status(400).json({ message: 'Request ID required.' });
        if (!['pending', 'processing', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status.' });
        }
        if (status === 'rejected' && (!rejectionReason || !String(rejectionReason).trim())) {
            return res.status(400).json({ message: 'Rejection reason is required when rejecting.' });
        }

        const requestRef = db.collection('withdrawalRequests').doc(id);
        const requestDoc = await requestRef.get();
        if (!requestDoc.exists) return res.status(404).json({ message: 'Withdrawal request not found.' });

        const updateData = {
            status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedBy: req.user.email,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (status === 'rejected') {
            updateData.rejectionReason = String(rejectionReason).trim();
        } else {
            updateData.rejectionReason = null;
        }

        await requestRef.update(updateData);
        console.log(`✅ [ADMIN] Withdrawal ${id} → ${status}`);

        res.json({ message: `Withdrawal request marked as "${status}".` });
    } catch (error) {
        console.error('Update withdrawal status error:', error);
        res.status(500).json({ message: 'Failed to update withdrawal request', error: error.message });
    }
});

// ================================================================
// 16. USER — LIVE CHAT
// ================================================================
app.get('/api/user/chat/messages', authMiddleware('user'), async (req, res) => {
    try {
        const userEmail = req.user.email;
        const limit = getLimit(req, 100, 300);

        const snapshot = await db.collection('chatMessages')
            .where('userEmail', '==', userEmail)
            .get();

        const messages = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            messages.push({
                id: doc.id,
                fromRole: d.fromRole,
                fromEmail: d.fromEmail,
                message: d.message,
                read: d.read || false,
                createdAt: safeDateToISO(d.createdAt),
            });
        });

        messages.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return at - bt;
        });

        res.json({ messages: messages.slice(-limit), total: messages.length });
    } catch (error) {
        console.error('User chat fetch error:', error);
        res.status(500).json({ message: 'Failed to fetch chat messages', error: error.message });
    }
});

app.post('/api/user/chat/send', authMiddleware('user'), async (req, res) => {
    try {
        const userEmail = req.user.email;
        const { message } = req.body;

        if (!message || !String(message).trim()) {
            return res.status(400).json({ message: 'Message cannot be empty.' });
        }
        if (String(message).length > 2000) {
            return res.status(400).json({ message: 'Message too long (max 2000 chars).' });
        }

        const docRef = await db.collection('chatMessages').add({
            userEmail,
            userId: req.user.uid,
            fromRole: 'user',
            fromEmail: userEmail,
            message: String(message).trim(),
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(201).json({ message: 'Message sent.', messageId: docRef.id });
    } catch (error) {
        console.error('User chat send error:', error);
        res.status(500).json({ message: 'Failed to send message', error: error.message });
    }
});

app.patch('/api/user/chat/read', authMiddleware('user'), async (req, res) => {
    try {
        const userEmail = req.user.email;

        const snapshot = await db.collection('chatMessages')
            .where('userEmail', '==', userEmail)
            .where('fromRole', '==', 'admin')
            .where('read', '==', false)
            .get();

        const batch = db.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { read: true }));
        await batch.commit();

        res.json({ message: 'Marked as read', count: snapshot.size });
    } catch (error) {
        console.error('User chat read error:', error);
        res.status(500).json({ message: 'Failed to mark messages as read', error: error.message });
    }
});

// ================================================================
// 17. ADMIN — LIVE CHAT (v1.4.0 improved — batch enrichment)
// ================================================================

/**
 * GET /api/admin/chat/users
 * Returns list of users with chat threads (with unread count + last message).
 */
app.get('/api/admin/chat/users', authMiddleware('admin'), async (req, res) => {
    try {
        console.log('🔄 [ADMIN CHAT] Fetching chat threads...');

        const snapshot = await db.collection('chatMessages').get();
        console.log(`  → ${snapshot.size} total chat messages in DB`);

        const threadsMap = {};
        let totalUnread = 0;

        snapshot.forEach(doc => {
            const d = doc.data();
            const email = d.userEmail;
            if (!email) return;

            const ts = d.createdAt ? d.createdAt.toDate().getTime() : 0;
            const isUnread = d.fromRole === 'user' && !d.read;

            if (isUnread) totalUnread++;

            if (!threadsMap[email]) {
                threadsMap[email] = {
                    userEmail: email,
                    userName: email.split('@')[0],
                    lastMessage: d.message,
                    lastMessageAt: ts,
                    lastFromRole: d.fromRole,
                    unreadCount: isUnread ? 1 : 0,
                };
            } else {
                if (isUnread) threadsMap[email].unreadCount++;
                if (ts > threadsMap[email].lastMessageAt) {
                    threadsMap[email].lastMessage = d.message;
                    threadsMap[email].lastMessageAt = ts;
                    threadsMap[email].lastFromRole = d.fromRole;
                }
            }
        });

        // Enrich with display names — batch of 10 (Firestore 'in' limit)
        const emails = Object.keys(threadsMap);
        if (emails.length > 0) {
            const chunkSize = 10;
            for (let i = 0; i < emails.length; i += chunkSize) {
                const chunk = emails.slice(i, i + chunkSize);
                try {
                    const usersSnapshot = await db.collection('users').where('email', 'in', chunk).get();
                    usersSnapshot.forEach(userDoc => {
                        const ud = userDoc.data();
                        if (ud.email && threadsMap[ud.email]) {
                            threadsMap[ud.email].userName = ud.displayName || ud.email.split('@')[0];
                        }
                    });
                } catch (enrichErr) {
                    console.warn('⚠️ User enrichment chunk failed (continuing):', enrichErr.message);
                }
            }
        }

        const threads = Object.values(threadsMap).sort((a, b) => b.lastMessageAt - a.lastMessageAt);

        console.log(`✅ [ADMIN CHAT] ${threads.length} threads, ${totalUnread} unread total`);

        res.json({
            threads,
            totalUnread,
            totalThreads: threads.length,
        });
    } catch (error) {
        console.error('❌ [ADMIN CHAT] Fetch threads error:', error);
        res.status(500).json({ message: 'Failed to fetch chat threads', error: error.message });
    }
});

app.get('/api/admin/chat/messages/:userEmail', authMiddleware('admin'), async (req, res) => {
    try {
        const userEmail = decodeURIComponent(req.params.userEmail);
        if (!userEmail) return res.status(400).json({ message: 'User email required.' });
        const limit = getLimit(req, 100, 300);

        const snapshot = await db.collection('chatMessages')
            .where('userEmail', '==', userEmail)
            .get();

        const messages = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            messages.push({
                id: doc.id,
                fromRole: d.fromRole,
                fromEmail: d.fromEmail,
                message: d.message,
                read: d.read || false,
                createdAt: safeDateToISO(d.createdAt),
            });
        });

        messages.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return at - bt;
        });

        res.json({ messages: messages.slice(-limit), total: messages.length });
    } catch (error) {
        console.error('Admin chat messages error:', error);
        res.status(500).json({ message: 'Failed to fetch messages', error: error.message });
    }
});

app.post('/api/admin/chat/send', authMiddleware('admin'), async (req, res) => {
    try {
        const { userEmail, message } = req.body;
        if (!userEmail || !String(userEmail).trim()) {
            return res.status(400).json({ message: 'User email required.' });
        }
        if (!message || !String(message).trim()) {
            return res.status(400).json({ message: 'Message cannot be empty.' });
        }
        if (String(message).length > 2000) {
            return res.status(400).json({ message: 'Message too long (max 2000 chars).' });
        }

        const userSnapshot = await db.collection('users')
            .where('email', '==', String(userEmail).trim())
            .where('role', '==', 'user')
            .get();
        if (userSnapshot.empty) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const docRef = await db.collection('chatMessages').add({
            userEmail: String(userEmail).trim(),
            userId: userSnapshot.docs[0].id,
            fromRole: 'admin',
            fromEmail: req.user.email,
            message: String(message).trim(),
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(201).json({ message: 'Message sent.', messageId: docRef.id });
    } catch (error) {
        console.error('Admin chat send error:', error);
        res.status(500).json({ message: 'Failed to send message', error: error.message });
    }
});

app.patch('/api/admin/chat/read/:userEmail', authMiddleware('admin'), async (req, res) => {
    try {
        const userEmail = decodeURIComponent(req.params.userEmail);
        if (!userEmail) return res.status(400).json({ message: 'User email required.' });

        const snapshot = await db.collection('chatMessages')
            .where('userEmail', '==', userEmail)
            .where('fromRole', '==', 'user')
            .where('read', '==', false)
            .get();

        const batch = db.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { read: true }));
        await batch.commit();

        res.json({ message: 'Marked as read', count: snapshot.size });
    } catch (error) {
        console.error('Admin chat read error:', error);
        res.status(500).json({ message: 'Failed to mark as read', error: error.message });
    }
});

// ================================================================
// 18. LEADERBOARD
// ================================================================
app.get('/api/leaderboard', authMiddleware('user'), async (req, res) => {
    try {
        const { period = 'week' } = req.query;

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const fromDate = new Date(today);
        if (period === 'week') fromDate.setDate(fromDate.getDate() - 7);
        else if (period === 'month') fromDate.setDate(fromDate.getDate() - 30);
        else return res.status(400).json({ message: 'Invalid period. Use "week" or "month".' });

        const fromStr = fromDate.toISOString().split('T')[0];

        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        if (usersSnapshot.empty) return res.json({ users: [] });

        const leaderboardData = [];
        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();
            const uid = userDoc.id;

            const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
            if (assignmentsSnapshot.empty) continue;

            let totalRevenue = 0;
            const statsPromises = [];
            assignmentsSnapshot.forEach(doc => {
                const data = doc.data();
                statsPromises.push(fetchStatsFromAdsterra(fromStr, todayStr, data.smartlinkId));
            });

            const statsResults = await Promise.all(statsPromises);
            statsResults.forEach(stats => { totalRevenue += stats.revenue || 0; });

            leaderboardData.push({
                uid,
                email: userData.email,
                displayName: userData.displayName || userData.email.split('@')[0] || 'User',
                revenue: totalRevenue,
            });
        }

        leaderboardData.sort((a, b) => b.revenue - a.revenue);
        const topUsers = leaderboardData.slice(0, 20);

        res.json({
            period,
            from: fromStr,
            to: todayStr,
            users: topUsers,
        });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ message: 'Failed to fetch leaderboard', error: error.message });
    }
});

// ================================================================
// 19. CHART DATA
// ================================================================
const aggregateDailyStats = async (linkIds, days) => {
    const dailyMap = {};
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        dailyMap[dateStr] = { date: dateStr, impressions: 0, clicks: 0, revenue: 0 };
    }

    for (const linkId of linkIds) {
        try {
            const dailyStats = await fetchDailyStatsForLink(linkId, days);
            dailyStats.forEach(day => {
                if (dailyMap[day.date]) {
                    dailyMap[day.date].impressions += day.impressions;
                    dailyMap[day.date].clicks += day.clicks;
                    dailyMap[day.date].revenue += day.revenue;
                }
            });
        } catch (err) {
            console.warn(`Failed to fetch daily stats for link ${linkId}:`, err.message);
        }
    }

    const sortedDates = Object.keys(dailyMap).sort();
    return sortedDates.map(date => dailyMap[date]);
};

app.get('/api/admin/chart-data', authMiddleware('admin'), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        if (days < 1 || days > 90) return res.status(400).json({ message: 'Days must be between 1 and 90' });

        const allLinks = await fetchSmartlinksFromAdsterra();
        const linkIds = allLinks.map(l => l.id);
        if (linkIds.length === 0) return res.json({ labels: [], impressions: [], clicks: [], revenue: [] });

        const dailyData = await aggregateDailyStats(linkIds, days);
        res.json({
            labels: dailyData.map(d => d.date),
            impressions: dailyData.map(d => d.impressions),
            clicks: dailyData.map(d => d.clicks),
            revenue: dailyData.map(d => d.revenue),
        });
    } catch (error) {
        console.error('Admin chart data error:', error);
        res.status(500).json({ message: 'Failed to fetch chart data', error: error.message });
    }
});

app.get('/api/user/chart-data', authMiddleware('user'), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        if (days < 1 || days > 90) return res.status(400).json({ message: 'Days must be between 1 and 90' });

        const uid = req.user.uid;
        const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
        const linkIds = [];
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.smartlinkId) linkIds.push(data.smartlinkId);
        });

        if (linkIds.length === 0) return res.json({ labels: [], impressions: [], clicks: [], revenue: [] });

        const dailyData = await aggregateDailyStats(linkIds, days);
        res.json({
            labels: dailyData.map(d => d.date),
            impressions: dailyData.map(d => d.impressions),
            clicks: dailyData.map(d => d.clicks),
            revenue: dailyData.map(d => d.revenue),
        });
    } catch (error) {
        console.error('User chart data error:', error);
        res.status(500).json({ message: 'Failed to fetch chart data', error: error.message });
    }
});

// -----------------------------
// 20. ROOT / HEALTH CHECK
// -----------------------------
app.get('/api', (req, res) => {
    res.json({
        name: 'Lunar Metrics API',
        version: '1.4.0',
        status: 'operational',
        features: [
            'auth',
            'adsterra-smartlinks',
            'admin-users',
            'admin-links',
            'user-stats',
            'user-analytics',
            'goals',
            'leaderboard',
            'chart-data',
            'self-service-claiming',
            'withdrawals',
            'live-chat',
            'balance',              // NEW v1.4.0
            'balance-validated-withdrawals', // NEW v1.4.0
            'crypto-split-methods', // NEW v1.4.0
        ],
        timestamp: new Date().toISOString(),
    });
});

module.exports = app;
