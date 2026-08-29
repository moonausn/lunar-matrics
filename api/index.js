// ============================================
// LUNAR METRICS · MASTER BACKEND
// All endpoints in one file (Vercel Serverless)
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

if (!FIREBASE_WEB_API_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !ADSTERRA_API_KEY || !JWT_SECRET) {
    console.error('❌ Missing required environment variables.');
    process.exit(1);
}

// -----------------------------
// 2. FIREBASE ADMIN SDK INIT
// -----------------------------
const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
    }),
});

const db = admin.firestore();

// -----------------------------
// 3. EXPRESS APP SETUP
// -----------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

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

            // Verify our custom JWT
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded; // { uid, email, role }

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
// 5. FIREBASE REST API HELPER (For login)
// -----------------------------
const firebaseAuth = async (email, password) => {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
    const response = await axios.post(url, {
        email,
        password,
        returnSecureToken: true,
    });
    return response.data; // { idToken, email, localId, ... }
};

// -----------------------------
// 6. ADSTERRA API HELPER
// -----------------------------
const fetchAdsterraStats = async (dateFrom, dateTo, linkIds = []) => {
    // As per Adsterra API documentation, we fetch stats and filter by placement_id or smartlink id.
    // NOTE: This is a generic implementation. Adjust endpoint/params per official docs.
    const url = `${ADSTERRA_BASE_URL}/statistics`;
    try {
        const response = await axios.get(url, {
            params: {
                from: dateFrom,
                to: dateTo,
                // Adsterra usually uses 'placement_id' or 'smartlink_id'. We'll map later.
                // For this example, we fetch all and filter server-side.
            },
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

// Helper to map Adsterra data to our metric structure
const mapAdsterraToMetrics = (rawData) => {
    // This is a placeholder structure. Adjust mapping based on actual Adsterra response.
    // Example mapping:
    return {
        impressions: rawData.impressions || 0,
        clicks: rawData.clicks || 0,
        cpm: rawData.cpm || 0,
        rpm: rawData.rpm || 0,
        revenue: rawData.revenue || 0,
    };
};

// -----------------------------
// 7. AUTH ENDPOINTS
// -----------------------------

// --- Admin Login ---
app.post('/api/auth/admin-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }

        // 1. Authenticate with Firebase
        const authData = await firebaseAuth(email, password);
        const uid = authData.localId;

        // 2. Check Firestore for admin role
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(403).json({ message: 'Access denied: User not found' });
        }

        const userData = userDoc.data();
        if (userData.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied: Not an administrator' });
        }

        // 3. Generate our own JWT
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

// --- User Login ---
app.post('/api/auth/user-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }

        // 1. Authenticate with Firebase
        const authData = await firebaseAuth(email, password);
        const uid = authData.localId;

        // 2. Check Firestore for user role
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(403).json({ message: 'Access denied: User not found' });
        }

        const userData = userDoc.data();
        if (userData.role !== 'user') {
            return res.status(403).json({ message: 'Access denied: Invalid user role' });
        }

        // 3. Generate our own JWT
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
// 8. ADMIN ENDPOINTS
// -----------------------------

// --- GET Smartlinks (from Adsterra) ---
app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    try {
        // Fetch smartlinks from Adsterra API
        // NOTE: Adjust endpoint based on official Adsterra docs.
        const url = `${ADSTERRA_BASE_URL}/smartlinks`;
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${ADSTERRA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        // Assuming response.data is an array of smartlinks.
        // Map them to our internal structure.
        let smartlinks = response.data.map(item => ({
            id: item.id || item.placement_id, // Adjust based on actual API
            name: item.name || item.label || 'Unnamed',
            status: 'available', // Default
            assignedTo: null,
        }));

        // Get assignments from Firestore to update statuses
        const assignmentsSnapshot = await db.collection('assignments').get();
        const assignments = {};
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            assignments[data.smartlinkId] = data.userEmail;
        });

        smartlinks = smartlinks.map(link => {
            if (assignments[link.id]) {
                return { ...link, status: 'assigned', assignedTo: assignments[link.id] };
            }
            return link;
        });

        res.json(smartlinks);
    } catch (error) {
        console.error('Smartlinks fetch error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Failed to fetch smartlinks' });
    }
});

// --- GET Users ---
app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        const users = [];
        const assignmentPromises = [];

        usersSnapshot.forEach(doc => {
            const data = doc.data();
            users.push({
                id: doc.id,
                email: data.email,
                role: data.role,
                permissions: data.permissions || {},
                smartlinkId: data.smartlinkId || null,
                smartlinkName: null,
            });
            if (data.smartlinkId) {
                assignmentPromises.push(
                    db.collection('assignments').doc(data.smartlinkId).get()
                );
            }
        });

        // Resolve assignment names
        const assignmentDocs = await Promise.all(assignmentPromises);
        const assignmentMap = {};
        assignmentDocs.forEach(doc => {
            if (doc.exists) {
                const data = doc.data();
                assignmentMap[doc.id] = data.smartlinkName || doc.id;
            }
        });

        users.forEach(user => {
            if (user.smartlinkId && assignmentMap[user.smartlinkId]) {
                user.smartlinkName = assignmentMap[user.smartlinkId];
            }
        });

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

        // 1. Create user in Firebase Auth (using Admin SDK)
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            emailVerified: false,
            disabled: false,
        });

        // 2. Save to Firestore with default role and permissions
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
        // Also remove any assignments
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

        // 1. Find user by email
        const userSnapshot = await db.collection('users').where('email', '==', email).where('role', '==', 'user').get();
        if (userSnapshot.empty) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userDoc = userSnapshot.docs[0];
        const uid = userDoc.id;

        // 2. Check if smartlink is already assigned
        const existingAssignment = await db.collection('assignments').doc(smartlinkId).get();
        if (existingAssignment.exists) {
            return res.status(400).json({ message: 'Smartlink already assigned to another user' });
        }

        // 3. Get smartlink name from Adsterra (or just use ID)
        // For simplicity, we'll use the ID as name. In production, fetch from Adsterra API.
        const smartlinkName = `Smartlink-${smartlinkId}`;

        // 4. Create assignment in Firestore
        await db.collection('assignments').doc(smartlinkId).set({
            userId: uid,
            userEmail: email,
            smartlinkId: smartlinkId,
            smartlinkName: smartlinkName,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // 5. Update user document with smartlinkId
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

        const assignmentData = assignmentDoc.data();
        const uid = assignmentData.userId;

        // Remove assignment from Firestore
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
// 9. USER DASHBOARD ENDPOINT
// -----------------------------
app.get('/api/user/stats', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;

        // 1. Get user data from Firestore
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
            // 2. Fetch stats from Adsterra for this specific smartlink
            // For demo, we'll use date range: today (or last 7 days)
            const today = new Date().toISOString().split('T')[0];
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            // Note: You need to adjust the Adsterra API call to filter by smartlink ID.
            // This is a placeholder for the actual API integration.
            const rawStats = await fetchAdsterraStats(sevenDaysAgo, today, [smartlinkId]);

            // Assume rawStats contains an array or object for the specific link.
            // We'll map it.
            const linkStats = rawStats.find(s => s.id === smartlinkId) || rawStats;
            metrics = mapAdsterraToMetrics(linkStats);

            // 3. Get smartlink name from assignments
            const assignmentDoc = await db.collection('assignments').doc(smartlinkId).get();
            const smartlinkName = assignmentDoc.exists ? assignmentDoc.data().smartlinkName : smartlinkId;

            smartlinkData = {
                id: smartlinkId,
                name: smartlinkName,
            };
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
// 11. EXPORT FOR VERCEL
// -----------------------------
module.exports = app;
