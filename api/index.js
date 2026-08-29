// ============================================
// LUNAR METRICS · MASTER BACKEND
// Real Adsterra API Integration
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
    const response = await axios.post(url, {
        email,
        password,
        returnSecureToken: true,
    });
    return response.data;
};

// -----------------------------
// 6. ADSTERRA API HELPERS (REAL INTEGRATION)
// -----------------------------

/**
 * Fetch all Smartlinks from Adsterra
 * Returns array of { id, name }
 */
const fetchSmartlinksFromAdsterra = async () => {
    try {
        // Adsterra endpoint to list smartlinks/placements
        // Adjust endpoint based on actual API docs.
        // Common endpoints: /smartlinks, /placements, /campaigns
        const url = `${ADSTERRA_BASE_URL}/smartlinks`;
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        // Assuming response.data is an array of objects with 'id' and 'name' or 'label'
        // Map to our structure
        let smartlinks = response.data.map(item => ({
            id: item.id || item.placement_id || item.smartlink_id,
            name: item.name || item.label || item.title || 'Unnamed',
        }));

        return smartlinks;
    } catch (error) {
        console.error('Adsterra Smartlinks fetch error:', error.response?.data || error.message);
        throw new Error('Failed to fetch smartlinks from Adsterra');
    }
};

/**
 * Fetch statistics for a specific smartlink (or all) from Adsterra
 * Returns an object with metrics or array of stats.
 */
const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    try {
        const url = `${ADSTERRA_BASE_URL}/statistics`;
        const params = {
            from: dateFrom,
            to: dateTo,
        };
        if (smartlinkId) {
            // Adsterra may use 'placement_id' or 'smartlink_id' - adjust accordingly.
            params.placement_id = smartlinkId;
            // Or params.smartlink_id = smartlinkId;
        }

        const response = await axios.get(url, {
            params: params,
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        // The response structure may vary. Common: { data: { items: [...] } } or array directly.
        // We'll assume it returns an array of stats objects for each placement.
        // Each object may have: impressions, clicks, cpm, rpm, revenue.
        // Some APIs return totals aggregated over the date range.
        // We'll try to handle both.
        let statsData = response.data;
        if (statsData.data && statsData.data.items) {
            statsData = statsData.data.items;
        }

        // If we requested a specific smartlink, find it in the array.
        if (smartlinkId && Array.isArray(statsData)) {
            const found = statsData.find(item => 
                (item.placement_id && item.placement_id == smartlinkId) ||
                (item.smartlink_id && item.smartlink_id == smartlinkId)
            );
            if (found) {
                return found;
            }
            // If not found, return empty metrics.
            return { impressions: 0, clicks: 0, cpm: 0, rpm: 0, revenue: 0 };
        }

        // If no smartlinkId, return the whole array (or aggregate)
        return statsData;
    } catch (error) {
        console.error('Adsterra Stats fetch error:', error.response?.data || error.message);
        throw new Error('Failed to fetch statistics from Adsterra');
    }
};

// Helper to map raw stats to our metric structure
const mapStatsToMetrics = (rawStats) => {
    return {
        impressions: rawStats.impressions || 0,
        clicks: rawStats.clicks || 0,
        cpm: rawStats.cpm || 0,
        rpm: rawStats.rpm || 0,
        revenue: rawStats.revenue || 0,
    };
};

// -----------------------------
// 7. AUTH ENDPOINTS
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
// 8. ADMIN ENDPOINTS (REAL DATA)
// -----------------------------

// --- GET Smartlinks (combine Adsterra + Firestore assignments) ---
app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    try {
        // Fetch from Adsterra
        const adsterraLinks = await fetchSmartlinksFromAdsterra();

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

        // Build response with status
        const smartlinks = adsterraLinks.map(link => {
            const assigned = assignments[link.id];
            if (assigned) {
                return {
                    ...link,
                    status: 'assigned',
                    assignedTo: assigned.userEmail,
                    assignedUserId: assigned.userId,
                };
            } else {
                return {
                    ...link,
                    status: 'available',
                    assignedTo: null,
                };
            }
        });

        res.json(smartlinks);
    } catch (error) {
        console.error('Smartlinks fetch error:', error.message);
        res.status(500).json({ message: 'Failed to fetch smartlinks' });
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
                // Get smartlink name from assignments collection
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
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }

        // Create in Firebase Auth
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            emailVerified: false,
            disabled: false,
        });

        // Save to Firestore with default permissions
        await db.collection('users').doc(userRecord.uid).set({
            email: email,
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

        res.status(201).json({ message: 'User created successfully', uid: userRecord.uid });
    } catch (error) {
        console.error('Create user error:', error);
        if (error.code === 'auth/email-already-exists') {
            return res.status(400).json({ message: 'Email already exists' });
        }
        res.status(500).json({ message: 'Failed to create user' });
    }
});

// --- DELETE User ---
app.delete('/api/admin/users/:uid', authMiddleware('admin'), async (req, res) => {
    try {
        const { uid } = req.params;
        // Delete from Firebase Auth
        await admin.auth().deleteUser(uid);
        // Delete from Firestore
        await db.collection('users').doc(uid).delete();
        // Remove assignments
        const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
        const batch = db.batch();
        assignmentsSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
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
        if (!email || !smartlinkId) {
            return res.status(400).json({ message: 'Email and Smartlink ID required' });
        }

        // Find user by email
        const userSnapshot = await db.collection('users').where('email', '==', email).where('role', '==', 'user').get();
        if (userSnapshot.empty) {
            return res.status(404).json({ message: 'User not found' });
        }
        const userDoc = userSnapshot.docs[0];
        const uid = userDoc.id;

        // Check if smartlink already assigned
        const existingAssignment = await db.collection('assignments').doc(smartlinkId).get();
        if (existingAssignment.exists) {
            return res.status(400).json({ message: 'Smartlink already assigned to another user' });
        }

        // Get smartlink name from Adsterra (optional: fetch from Adsterra API)
        // For simplicity, we'll fetch from Adsterra or fallback to ID.
        let smartlinkName = smartlinkId;
        try {
            const adsterraLinks = await fetchSmartlinksFromAdsterra();
            const found = adsterraLinks.find(l => l.id == smartlinkId);
            if (found) smartlinkName = found.name;
        } catch (e) {
            console.warn('Could not fetch smartlink name from Adsterra, using ID.');
        }

        // Create assignment in Firestore
        await db.collection('assignments').doc(smartlinkId).set({
            userId: uid,
            userEmail: email,
            smartlinkId: smartlinkId,
            smartlinkName: smartlinkName,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Update user document
        await db.collection('users').doc(uid).update({
            smartlinkId: smartlinkId,
        });

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
        if (!smartlinkId) {
            return res.status(400).json({ message: 'Smartlink ID required' });
        }

        const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
        if (!assignmentDoc.exists) {
            return res.status(404).json({ message: 'Assignment not found' });
        }

        const uid = assignmentDoc.data().userId;

        // Remove assignment
        await db.collection('assignments').doc(smartlinkId).delete();

        // Update user document
        if (uid) {
            await db.collection('users').doc(uid).update({
                smartlinkId: null,
            });
        }

        res.json({ message: 'Smartlink unassigned successfully' });
    } catch (error) {
        console.error('Unassign error:', error);
        res.status(500).json({ message: 'Failed to unassign smartlink' });
    }
});

// --- UPDATE Permissions (Metric Toggles) ---
app.patch('/api/admin/permissions', authMiddleware('admin'), async (req, res) => {
    try {
        const { userId, metric, value } = req.body;
        if (!userId || !metric || value === undefined) {
            return res.status(400).json({ message: 'userId, metric, and value required' });
        }

        const validMetrics = ['impressions', 'clicks', 'cpm', 'rpm', 'revenue'];
        if (!validMetrics.includes(metric)) {
            return res.status(400).json({ message: 'Invalid metric' });
        }

        const userRef = db.collection('users').doc(userId);
        const updateData = {};
        updateData[`permissions.${metric}`] = value;

        await userRef.update(updateData);

        res.json({ message: 'Permission updated successfully' });
    } catch (error) {
        console.error('Permission update error:', error);
        res.status(500).json({ message: 'Failed to update permission' });
    }
});

// -----------------------------
// 9. USER DASHBOARD STATS (REAL DATA)
// -----------------------------
app.get('/api/user/stats', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;

        // Get user data
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userData = userDoc.data();
        const permissions = userData.permissions || {};
        const smartlinkId = userData.smartlinkId || null;

        let smartlinkData = null;
        let metrics = {};

        if (smartlinkId) {
            // Get smartlink name from assignments
            const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
            const smartlinkName = assignmentDoc.exists ? assignmentDoc.data().smartlinkName : smartlinkId;

            smartlinkData = {
                id: smartlinkId,
                name: smartlinkName,
            };

            // Fetch stats from Adsterra for this smartlink
            // Date range: last 7 days (or today)
            const today = new Date().toISOString().split('T')[0];
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            try {
                const rawStats = await fetchStatsFromAdsterra(sevenDaysAgo, today, smartlinkId);
                // If rawStats is an array, find the correct one; else use directly.
                let statsForLink = rawStats;
                if (Array.isArray(rawStats)) {
                    statsForLink = rawStats.find(item => 
                        (item.placement_id && item.placement_id == smartlinkId) ||
                        (item.smartlink_id && item.smartlink_id == smartlinkId)
                    ) || {};
                }
                metrics = mapStatsToMetrics(statsForLink);
            } catch (error) {
                console.error('Stats fetch error for user:', error);
                // Return empty metrics instead of failing entirely
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
