// ============================================
// LUNAR METRICS · MASTER BACKEND
// Real Smartlink Names (alias) + URL + Signup + Analytics
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
console.log(`  ADSTERRA_API_KEY: ${ADSTERRA_API_KEY ? '✅ Set' : '❌ MISSING'}`);
console.log(`  ADSTERRA_BASE_URL: ${ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/'}`);
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
    });
});

// ----- ADSTERRA TEST ENDPOINT -----
app.get('/api/test-adsterra', async (req, res) => {
    try {
        let baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/';
        if (!baseUrl.endsWith('/')) {
            baseUrl += '/';
        }
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
        if (response.data && response.data.data && Array.isArray(response.data.data.items)) {
            items = response.data.data.items;
        } else if (response.data && Array.isArray(response.data)) {
            items = response.data;
        } else if (response.data && response.data.items && Array.isArray(response.data.items)) {
            items = response.data.items;
        }

        const sample = items.slice(0, 5).map(i => ({
            id: i.id || i.smart_link_id || i.placement_id,
            title: i.title,
            alias: i.alias,
            url: i.url,
            allKeys: Object.keys(i),
        }));

        res.json({
            success: true,
            count: items.length,
            sample: sample,
            fullData: response.data,
        });
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
// 5. FIREBASE REST API HELPER (for login)
// -----------------------------
const firebaseAuth = async (email, password) => {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
    const response = await axios.post(url, { email, password, returnSecureToken: true });
    return response.data;
};

// -----------------------------
// 6. ADSTERRA API HELPERS
// -----------------------------

/**
 * Fetch ALL Smartlinks from Adsterra with REAL names (alias) AND URL
 */
const fetchSmartlinksFromAdsterra = async () => {
    let baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/';
    if (!baseUrl.endsWith('/')) {
        baseUrl += '/';
    }
    const url = `${baseUrl}smart-links.json`;

    console.log(`🔄 Fetching real smartlinks from: ${url} using X-API-Key`);

    try {
        const response = await axios.get(url, {
            headers: {
                'X-API-Key': ADSTERRA_API_KEY,
                'Accept': 'application/json',
            },
            timeout: 15000,
        });

        if (response.status !== 200) {
            throw new Error(`Adsterra returned status ${response.status}`);
        }

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
            throw new Error('Unexpected response structure from Adsterra');
        }

        if (items.length === 0) {
            console.warn('⚠️ Adsterra returned 0 smartlinks');
        }

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
            
            if (!name) {
                name = item.id || item.smart_link_id || item.placement_id || 'Unnamed';
            }

            return {
                id: item.id || item.smart_link_id || item.placement_id || String(item),
                name: name,
                url: item.url || '',
            };
        });

        console.log(`✅ Fetched ${mapped.length} smartlinks with names and URLs`);
        mapped.slice(0, 3).forEach((link, i) => {
            console.log(`  ${i+1}. ${link.id} → ${link.name} → ${link.url ? '✅ URL' : '❌ No URL'}`);
        });

        return mapped;
    } catch (error) {
        console.error('❌ Adsterra API error:', error.response?.data || error.message);
        throw new Error(`Failed to fetch real data from Adsterra: ${error.response?.data?.message || error.message}`);
    }
};

/**
 * Fetch statistics for a specific smartlink for a given date range
 */
const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    try {
        let baseUrl = ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/';
        if (!baseUrl.endsWith('/')) {
            baseUrl += '/';
        }
        const url = `${baseUrl}stats.json`;

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
                'X-API-Key': ADSTERRA_API_KEY,
                'Accept': 'application/json'
            },
            timeout: 15000,
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
// 7. AUTH ENDPOINTS (including signup)
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

// ----- USER SIGNUP (NEW) -----
app.post('/api/auth/user-signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email, and password are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        // 1. Create user in Firebase Auth
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            emailVerified: false,
            disabled: false,
            displayName: name, // set displayName in Auth
        });

        // 2. Save to Firestore with default permissions
        await db.collection('users').doc(userRecord.uid).set({
            email: email,
            displayName: name,
            role: 'user',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            permissions: {
                impressions: true,
                clicks: true,
                cpm: true,
                rpm: true,
                revenue: true,
            },
            smartlinkId: null,
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

// ============================================
// 8. ADMIN ENDPOINTS
// ============================================

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
            };
        });

        const smartlinks = adsterraLinks.map(link => {
            const assigned = assignments[link.id];
            return {
                ...link,
                status: assigned ? 'assigned' : 'available',
                assignedTo: assigned ? assigned.userEmail : null,
                assignedUserId: assigned ? assigned.userId : null,
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
        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        const users = [];
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
            });
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
            if (found && found.name) smartlinkName = found.name;
        } catch (error) {
            console.warn(`⚠️ Could not fetch name from Adsterra: ${error.message}`);
        }

        await db.collection('assignments').doc(smartlinkId).set({
            userId: uid,
            userEmail: email,
            smartlinkId,
            smartlinkName,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await db.collection('users').doc(uid).update({ smartlinkId });

        res.json({ message: `Link "${smartlinkName}" assigned successfully` });
    } catch (error) {
        console.error('Assign error:', error);
        res.status(500).json({ message: 'Failed to assign link' });
    }
});

app.post('/api/admin/unassign', authMiddleware('admin'), async (req, res) => {
    try {
        const { smartlinkId } = req.body;
        if (!smartlinkId) return res.status(400).json({ message: 'Smartlink ID required' });

        const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
        if (!assignmentDoc.exists) return res.status(404).json({ message: 'Assignment not found' });

        const uid = assignmentDoc.data().userId;
        await db.collection('assignments').doc(smartlinkId).delete();

        const remainingAssignments = await db.collection('assignments').where('userId', '==', uid).get();
        if (remainingAssignments.empty) {
            await db.collection('users').doc(uid).update({ smartlinkId: null });
        }

        res.json({ message: 'Link unassigned successfully' });
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

// ============================================
// 9. FIX EXISTING ASSIGNMENT NAMES
// ============================================
app.get('/api/admin/fix-names', authMiddleware('admin'), async (req, res) => {
    try {
        console.log('🔄 Starting name fix for all assignments...');
        const adsterraLinks = await fetchSmartlinksFromAdsterra();
        const nameMap = {};
        adsterraLinks.forEach(link => { nameMap[link.id] = link.name; });

        console.log(`✅ Fetched ${Object.keys(nameMap).length} real names from Adsterra`);

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
                console.log(`✅ Updated ${data.smartlinkId}: ${data.smartlinkName} → ${realName}`);
            } else if (!realName) {
                notFoundCount++;
                console.warn(`⚠️ No real name found for ${data.smartlinkId}`);
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

// ============================================
// 10. USER STATS
// ============================================
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

        res.json({
            userEmail: userData.email,
            permissions: permissions,
            smartlinks: smartlinks,
        });
    } catch (error) {
        console.error('User stats error:', error);
        res.status(500).json({ message: 'Failed to fetch user statistics' });
    }
});

// ============================================
// 11. USER ANALYTICS (NEW)
// ============================================
app.get('/api/user/analytics', authMiddleware('user'), async (req, res) => {
    try {
        const currentUid = req.user.uid;

        // 1. Fetch all users with role 'user' except the current user
        const usersSnapshot = await db.collection('users')
            .where('role', '==', 'user')
            .get();

        const otherUsers = [];
        for (const doc of usersSnapshot.docs) {
            if (doc.id === currentUid) continue; // exclude self
            const data = doc.data();
            otherUsers.push({
                uid: doc.id,
                email: data.email,
                displayName: data.displayName || data.email.split('@')[0] || 'User',
            });
        }

        // 2. For each user, get total daily clicks from all their assigned smartlinks
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // next day

        const analytics = [];

        for (const user of otherUsers) {
            // Fetch assignments for this user
            const assignmentsSnapshot = await db.collection('assignments')
                .where('userId', '==', user.uid)
                .get();

            let totalClicks = 0;

            if (!assignmentsSnapshot.empty) {
                for (const doc of assignmentsSnapshot.docs) {
                    const assignmentData = doc.data();
                    const smartlinkId = assignmentData.smartlinkId;
                    try {
                        // Get today's stats for this smartlink
                        const rawStats = await fetchStatsFromAdsterra(today, tomorrow, smartlinkId);
                        const clicks = rawStats.clicks || 0;
                        totalClicks += clicks;
                    } catch (error) {
                        console.warn(`⚠️ Failed to fetch stats for link ${smartlinkId} for user ${user.email}:`, error.message);
                        // Skip this link, continue with others
                    }
                }
            }

            analytics.push({
                displayName: user.displayName,
                email: user.email,
                totalClicks: totalClicks,
            });
        }

        // Sort by total clicks descending (optional)
        analytics.sort((a, b) => b.totalClicks - a.totalClicks);

        res.json({
            users: analytics,
            updatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('User analytics error:', error);
        res.status(500).json({ message: 'Failed to fetch user analytics' });
    }
});

// ============================================
// 12. ROOT / HEALTH CHECK
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
