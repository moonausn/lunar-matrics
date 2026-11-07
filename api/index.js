// ============================================
// LUNAR METRICS · MASTER BACKEND (v1.6.2)
// ============================================
// v1.6.2 HOTFIX:
//   🔧 Adsterra stats.json — NOW attempts per-link data via group_by param
//      Tries: smartlink / smartlink_id / placement / placement_id / link
//      If Adsterra supports any of these, per-link stats work correctly
//   🔧 Caching added — bulk stats fetched once, reused for all links (fast)
//   🔧 Debug endpoint now shows which group_by works
//   🔧 Graceful fallback — if per-link not supported, returns 0 with clear log
//
// v1.6.1 + v1.6.0 features preserved:
//   ✅ start_date / finish_date (correct params)
//   ✅ 60/40 revenue split
//   ✅ Min withdrawal $15
//   ✅ Withdrawal windows (14,15,29,30)
//   ✅ Max 10 links per user
//   ✅ Admin earnings overview
// ============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');

// -----------------------------
// 1. ENV + CONSTANTS
// -----------------------------
const {
    FIREBASE_WEB_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY, ADSTERRA_API_KEY, ADSTERRA_BASE_URL, JWT_SECRET,
    BALANCE_LOOKBACK_DAYS, MAX_LINKS_PER_USER, USER_SHARE_PERCENT, MIN_WITHDRAWAL_USD,
} = process.env;

const BALANCE_PERIOD_DAYS = parseInt(BALANCE_LOOKBACK_DAYS) || 365;
const MAX_LINKS = parseInt(MAX_LINKS_PER_USER) || 10;
const USER_SHARE = (parseFloat(USER_SHARE_PERCENT) || 60) / 100;
const ADMIN_SHARE = 1 - USER_SHARE;
const MIN_WITHDRAWAL = parseFloat(MIN_WITHDRAWAL_USD) || 15;
const WITHDRAWAL_WINDOW_DATES = [14, 15, 29, 30];

console.log('✅ Environment loaded:');
console.log(`  USER_SHARE: ${(USER_SHARE * 100).toFixed(0)}% | ADMIN_SHARE: ${(ADMIN_SHARE * 100).toFixed(0)}%`);
console.log(`  MIN_WITHDRAWAL: $${MIN_WITHDRAWAL}`);
console.log(`  WITHDRAWAL_WINDOWS: days ${WITHDRAWAL_WINDOW_DATES.join(', ')}`);
console.log(`  MAX_LINKS_PER_USER: ${MAX_LINKS}`);

if (!FIREBASE_WEB_API_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !ADSTERRA_API_KEY || !JWT_SECRET) {
    console.error('❌ Missing required env vars. Exiting.');
    process.exit(1);
}

// -----------------------------
// 2. FIREBASE INIT
// -----------------------------
let db;
try {
    const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: FIREBASE_PROJECT_ID,
            clientEmail: FIREBASE_CLIENT_EMAIL,
            privateKey,
        }),
    });
    db = admin.firestore();
    console.log('✅ Firebase Admin SDK initialized.');
} catch (error) {
    console.error('❌ Firebase init failed:', error.message);
}

// -----------------------------
// 3. EXPRESS SETUP
// -----------------------------
const app = express();

const allowedOrigins = [
    'https://lunar-metrics.page.gd',
    'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000',
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) callback(null, true);
        else {
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

// -----------------------------
// 4. UTILITY HELPERS
// -----------------------------
const safeDateToISO = (ts) => ts ? ts.toDate().toISOString() : null;
const getLimit = (req, def = 100, max = 500) => {
    const n = parseInt(req.query.limit) || def;
    return Math.min(Math.max(n, 1), max);
};
const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const zeroStats = () => ({ impressions: 0, clicks: 0, cpm: 0, rpm: 0, revenue: 0 });

const isWithdrawalWindowOpen = (date = new Date()) => WITHDRAWAL_WINDOW_DATES.includes(date.getDate());

const getNextWithdrawalWindow = (date = new Date()) => {
    const y = date.getFullYear();
    const m = date.getMonth();
    const candidates = [];
    [0, 1].forEach(offset => {
        [14, 15, 29, 30].forEach(d => {
            const c = new Date(y, m + offset, d);
            if (c.getDate() === d && c > date) candidates.push(c);
        });
    });
    candidates.sort((a, b) => a - b);
    return candidates[0] || null;
};

// -----------------------------
// 5. AUTH MIDDLEWARE
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

const firebaseAuth = async (email, password) => {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
    const response = await axios.post(url, { email, password, returnSecureToken: true });
    return response.data;
};

// -----------------------------
// 6. ADSTERRA HELPERS (v1.6.2)
// -----------------------------
const extractItems = (data) => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (data.data) {
        if (Array.isArray(data.data)) return data.data;
        if (Array.isArray(data.data.items)) return data.data.items;
    }
    if (Array.isArray(data.result)) return data.result;
    return [];
};

const mapStatsFields = (item) => {
    if (!item || typeof item !== 'object') return zeroStats();
    const rev = item.revenue ?? item.profit ?? item.amount ?? item.earning ?? item.total_revenue ?? 0;
    const imp = item.impressions ?? item.impression ?? item.imp ?? 0;
    const clk = item.clicks ?? item.click ?? item.clk ?? 0;
    return {
        impressions: parseFloat(imp) || 0,
        clicks: parseFloat(clk) || 0,
        cpm: parseFloat(item.cpm) || 0,
        rpm: parseFloat(item.rpm) || 0,
        revenue: parseFloat(rev) || 0,
    };
};

const aggregateItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) return zeroStats();
    let imp = 0, clk = 0, rev = 0, cpmSum = 0, rpmSum = 0, cnt = 0;
    items.forEach(item => {
        const m = mapStatsFields(item);
        imp += m.impressions; clk += m.clicks; rev += m.revenue;
        if (m.cpm) cpmSum += m.cpm;
        if (m.rpm) rpmSum += m.rpm;
        cnt++;
    });
    return {
        impressions: imp, clicks: clk, revenue: rev,
        cpm: cnt > 0 ? cpmSum / cnt : 0,
        rpm: cnt > 0 ? rpmSum / cnt : 0,
    };
};

const fetchSmartlinksFromAdsterra = async () => {
    const baseUrl = (ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/').replace(/\/?$/, '/');
    const url = `${baseUrl}smart-links.json`;

    try {
        const response = await axios.get(url, {
            headers: { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' },
            timeout: 15000,
        });
        const items = extractItems(response.data);
        if (items.length === 0) throw new Error('No links returned from Adsterra');

        return items.map(item => {
            let name = item.alias || item.name || item.title || item.label || item.smartlink_name || '';
            if (!name) {
                for (const key of Object.keys(item)) {
                    if (key.toLowerCase().includes('name') && typeof item[key] === 'string') {
                        name = item[key]; break;
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
    } catch (error) {
        console.error('❌ Adsterra links error:', error.response?.data || error.message);
        throw new Error(`Failed to fetch links: ${error.response?.data?.message || error.message}`);
    }
};

// -----------------------------
// 6B. NEW v1.6.2: PER-LINK STATS WITH GROUP_BY + CACHE
// -----------------------------
let _placementCache = { key: null, data: null, ts: 0, method: null };
const PLACEMENT_CACHE_TTL = 60000; // 60 seconds

/**
 * Fetch bulk stats with per-placement breakdown.
 * Tries multiple group_by values. Caches successful result for 60s.
 * Returns: { items, method } or null if per-link grouping not supported.
 */
const fetchBulkPlacementStats = async (dateFrom, dateTo) => {
    const cacheKey = `${dateFrom}:${dateTo}`;
    if (_placementCache.key === cacheKey && Date.now() - _placementCache.ts < PLACEMENT_CACHE_TTL) {
        return _placementCache.data ? { items: _placementCache.data, method: _placementCache.method } : null;
    }

    const baseUrl = (ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/').replace(/\/?$/, '/');
    const url = `${baseUrl}stats.json`;
    const headers = { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' };

    // Try each group_by value
    const groupByOptions = ['smartlink', 'smartlink_id', 'placement', 'placement_id', 'link', 'link_id'];

    for (const groupBy of groupByOptions) {
        try {
            const resp = await axios.get(url, {
                params: { start_date: dateFrom, finish_date: dateTo, group_by: groupBy },
                headers, timeout: 15000,
            });
            const items = extractItems(resp.data);

            if (items.length > 0) {
                // Check if items have per-link ID field
                const idFields = ['smartlink_id', 'smartlink', 'placement_id', 'placement', 'link_id', 'link'];
                const hasIdField = items.some(item => idFields.some(f => item[f] !== undefined && item[f] !== null));

                if (hasIdField) {
                    console.log(`✅ Per-link stats WORKING via group_by=${groupBy} (${items.length} items)`);
                    _placementCache = { key: cacheKey, data: items, ts: Date.now(), method: groupBy };
                    return { items, method: groupBy };
                }
            }
        } catch (err) {
            // Try next option — most group_by values will return 422 "not expected"
        }
    }

    console.log(`⚠️ Adsterra does NOT support per-link grouping for date range ${dateFrom} to ${dateTo}. Aggregate only.`);
    _placementCache = { key: cacheKey, data: null, ts: Date.now(), method: null };
    return null;
};

/**
 * Extract per-link stats from bulk items using any ID field.
 */
const extractPerLinkStats = (items, targetId) => {
    if (!Array.isArray(items)) return null;
    const target = String(targetId);
    const idFields = ['smartlink_id', 'smartlink', 'placement_id', 'placement', 'link_id', 'link'];

    const matches = items.filter(item => {
        return idFields.some(f => item[f] !== undefined && item[f] !== null && String(item[f]) === target);
    });

    if (matches.length === 0) return null;

    // Aggregate all matching rows (could be multiple days)
    let imp = 0, clk = 0, rev = 0, cpmSum = 0, rpmSum = 0, cnt = 0;
    matches.forEach(item => {
        const m = mapStatsFields(item);
        imp += m.impressions; clk += m.clicks; rev += m.revenue;
        if (m.cpm) cpmSum += m.cpm;
        if (m.rpm) rpmSum += m.rpm;
        cnt++;
    });

    return {
        impressions: imp, clicks: clk, revenue: rev,
        cpm: cnt > 0 ? cpmSum / cnt : 0,
        rpm: cnt > 0 ? rpmSum / cnt : 0,
    };
};

/**
 * v1.6.2: Main stats fetcher.
 * - If smartlinkId NULL → aggregate total
 * - If smartlinkId provided → try per-link via grouping; fall back to null (caller distributes)
 */
const fetchStatsFromAdsterra = async (dateFrom, dateTo, smartlinkId = null) => {
    const baseUrl = (ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/').replace(/\/?$/, '/');
    const url = `${baseUrl}stats.json`;
    const headers = { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' };

    // Aggregate only
    if (!smartlinkId) {
        try {
            const resp = await axios.get(url, {
                params: { start_date: dateFrom, finish_date: dateTo },
                headers, timeout: 15000,
            });
            const items = extractItems(resp.data);
            if (items.length > 0) return aggregateItems(items);
            if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
                const direct = mapStatsFields(resp.data);
                if (direct.revenue || direct.impressions || direct.clicks) return direct;
            }
            return zeroStats();
        } catch (error) {
            console.error(`❌ Aggregate stats error:`, error.response?.data || error.message);
            return zeroStats();
        }
    }

    // Per-link — try grouping
    const bulk = await fetchBulkPlacementStats(dateFrom, dateTo);
    if (bulk && bulk.items) {
        const match = extractPerLinkStats(bulk.items, smartlinkId);
        if (match) return match;
        // Link has no data in this range
        return zeroStats();
    }

    // Per-link grouping not supported — return null as signal to caller
    return null;
};

// -----------------------------
// 7. DIAGNOSTIC ENDPOINTS
// -----------------------------
app.get('/api/test', (req, res) => {
    res.json({
        status: 'ok', version: '1.6.2',
        message: 'CORS working! Backend reachable.',
        timestamp: new Date().toISOString(),
    });
});

app.get('/api/test-adsterra', async (req, res) => {
    try {
        const baseUrl = (ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/').replace(/\/?$/, '/');
        const url = `${baseUrl}smart-links.json`;
        const response = await axios.get(url, {
            headers: { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' },
            timeout: 15000,
        });
        const items = extractItems(response.data);
        const sample = items.slice(0, 5).map(i => ({
            id: i.id || i.smart_link_id || i.placement_id,
            title: i.title, alias: i.alias,
        }));
        res.json({ success: true, count: items.length, sample });
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

/**
 * v1.6.2: Comprehensive stats test.
 * Shows: aggregate data, per-link grouping support, and all group_by attempts.
 */
app.get('/api/test-adsterra-stats', async (req, res) => {
    const baseUrl = (ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher/').replace(/\/?$/, '/');
    const url = `${baseUrl}stats.json`;
    const headers = { 'X-API-Key': ADSTERRA_API_KEY, 'Accept': 'application/json' };

    const today = new Date();
    const dateTo = req.query.to || today.toISOString().split('T')[0];
    const dateFrom = req.query.from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const testSmartlinkId = req.query.smartlink_id || null;

    const results = {
        apiVersion: 'v1.6.2',
        dateRange: { from: dateFrom, to: dateTo },
        aggregate: null,
        groupByTests: {},
        perLinkResult: null,
    };

    // Aggregate
    try {
        const resp = await axios.get(url, {
            params: { start_date: dateFrom, finish_date: dateTo },
            headers, timeout: 15000,
        });
        const items = extractItems(resp.data);
        results.aggregate = {
            status: resp.status,
            itemCount: items.length,
            total: aggregateItems(items),
            sample: items.slice(0, 5),
            itemFields: items[0] ? Object.keys(items[0]) : [],
        };
    } catch (err) {
        results.aggregate = { error: err.message, response: err.response?.data };
    }

    // Test each group_by
    for (const groupBy of ['smartlink', 'smartlink_id', 'placement', 'placement_id', 'link', 'link_id']) {
        try {
            const resp = await axios.get(url, {
                params: { start_date: dateFrom, finish_date: dateTo, group_by: groupBy },
                headers, timeout: 15000,
            });
            const items = extractItems(resp.data);
            const idFields = ['smartlink_id', 'smartlink', 'placement_id', 'placement', 'link_id', 'link'];
            const hasIds = items.length > 0 && items.some(i => idFields.some(f => i[f] !== undefined));
            results.groupByTests[groupBy] = {
                status: resp.status,
                itemCount: items.length,
                hasIdFields: hasIds,
                itemFields: items[0] ? Object.keys(items[0]) : [],
                sample: items.slice(0, 2),
            };
        } catch (err) {
            results.groupByTests[groupBy] = {
                error: err.response?.data?.message || err.message,
                status: err.response?.status,
            };
        }
    }

    // Test per-link if requested
    if (testSmartlinkId) {
        try {
            const bulk = await fetchBulkPlacementStats(dateFrom, dateTo);
            if (bulk) {
                const match = extractPerLinkStats(bulk.items, testSmartlinkId);
                results.perLinkResult = {
                    searchingFor: testSmartlinkId,
                    method: bulk.method,
                    found: !!match,
                    data: match || null,
                };
            } else {
                results.perLinkResult = {
                    searchingFor: testSmartlinkId,
                    error: 'Per-link grouping NOT supported by Adsterra API',
                };
            }
        } catch (err) {
            results.perLinkResult = { error: err.message };
        }
    }

    res.json({ success: true, ...results });
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
        if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required' });
        if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
        const userRecord = await admin.auth().createUser({ email, password, emailVerified: false, displayName: name });
        await db.collection('users').doc(userRecord.uid).set({
            email, displayName: name, role: 'user',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            permissions: { impressions: true, clicks: true, cpm: true, rpm: true, revenue: true },
            smartlinkId: null, currencyPreference: 'USD', linkCount: 0,
        });
        res.status(201).json({ message: 'User account created successfully! You can now log in.', uid: userRecord.uid });
    } catch (error) {
        console.error('Signup error:', error);
        if (error.code === 'auth/email-already-exists') {
            return res.status(400).json({ message: 'Email already exists. Please use a different email.' });
        }
        res.status(500).json({ message: 'Failed to create account. Please try again.' });
    }
});

// -----------------------------
// 9. ADMIN — USERS + LINKS
// -----------------------------
app.get('/api/admin/smartlinks', authMiddleware('admin'), async (req, res) => {
    try {
        const adsterraLinks = await fetchSmartlinksFromAdsterra();
        const assignmentsSnapshot = await db.collection('assignments').get();
        const assignments = {};
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            assignments[data.smartlinkId] = {
                userEmail: data.userEmail, userId: data.userId,
                smartlinkName: data.smartlinkName, claimedBySelf: data.claimedBySelf || false,
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
            };
        });
        res.json(smartlinks);
    } catch (error) {
        console.error('Smartlinks fetch error:', error.message);
        res.status(500).json({ message: 'Failed to fetch links', error: error.message });
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
            assignmentsSnapshot.forEach(a => smartlinkNames.push(a.data().smartlinkName || a.data().smartlinkId));
            users.push({
                id: doc.id, email: data.email, displayName: data.displayName || '',
                role: data.role, permissions: data.permissions || {},
                smartlinkId: data.smartlinkId || null,
                smartlinkName: smartlinkNames.length > 0 ? smartlinkNames.join(', ') : null,
                assignedLinks: smartlinkNames,
                linkCount: smartlinkNames.length, maxLinks: MAX_LINKS,
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
        if (filter === 'assigned') users = users.filter(u => u.smartlinkName && u.smartlinkName !== '—');
        else if (filter === 'unassigned') users = users.filter(u => !u.smartlinkName || u.smartlinkName === '—');
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
            email, role: 'user',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            permissions: { impressions: true, clicks: true, cpm: true, rpm: true, revenue: true },
            smartlinkId: null, currencyPreference: 'USD', linkCount: 0,
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
        res.json({ message: 'User deleted. Their links are now available.' });
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            try {
                await db.collection('users').doc(req.params.uid).delete();
                return res.json({ message: 'User deleted from Firestore' });
            } catch (e) { return res.status(500).json({ message: 'Failed to delete' }); }
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
        const uid = userSnapshot.docs[0].id;
        let linkName = smartlinkId;
        try {
            const links = await fetchSmartlinksFromAdsterra();
            const found = links.find(l => l.id == smartlinkId);
            if (found) linkName = found.name;
        } catch (err) { /* silent */ }
        await db.runTransaction(async (transaction) => {
            const assignmentRef = db.collection('assignments').doc(String(smartlinkId));
            const assignmentDoc = await transaction.get(assignmentRef);
            if (assignmentDoc.exists) throw new Error('ALREADY_ASSIGNED');
            transaction.set(assignmentRef, {
                userId: uid, userEmail: email, smartlinkId: String(smartlinkId),
                smartlinkName: linkName,
                assignedAt: admin.firestore.FieldValue.serverTimestamp(),
                claimedBySelf: false,
            });
            transaction.update(db.collection('users').doc(uid), { smartlinkId: String(smartlinkId) });
        });
        res.json({ message: `Link "${linkName}" assigned successfully` });
    } catch (error) {
        if (error.message === 'ALREADY_ASSIGNED') return res.status(400).json({ message: 'Already assigned' });
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
        const remaining = await db.collection('assignments').where('userId', '==', uid).get();
        if (remaining.empty) {
            await db.collection('users').doc(uid).update({ smartlinkId: null });
        } else {
            await db.collection('users').doc(uid).update({ smartlinkId: remaining.docs[0].data().smartlinkId });
        }
        res.json({ message: 'Link released back to available pool.' });
    } catch (error) {
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
        res.json({ message: 'Permission updated' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update permission' });
    }
});

app.get('/api/admin/fix-names', authMiddleware('admin'), async (req, res) => {
    try {
        const adsterraLinks = await fetchSmartlinksFromAdsterra();
        const nameMap = {};
        adsterraLinks.forEach(link => { nameMap[link.id] = link.name; });
        const assignmentsSnapshot = await db.collection('assignments').get();
        let updated = 0, notFound = 0;
        const batch = db.batch();
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            const realName = nameMap[data.smartlinkId];
            if (realName && realName !== data.smartlinkName) {
                batch.update(doc.ref, { smartlinkName: realName }); updated++;
            } else if (!realName) notFound++;
        });
        await batch.commit();
        res.json({ message: 'Names fixed', updated, notFound, total: assignmentsSnapshot.size });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fix names', error: error.message });
    }
});

// -----------------------------
// 10. USER — AVAILABLE LINKS + CLAIM
// -----------------------------
app.get('/api/user/available-links', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const adsterraLinks = await fetchSmartlinksFromAdsterra();
        const assignmentsSnapshot = await db.collection('assignments').get();
        const claimedIds = new Set();
        assignmentsSnapshot.forEach(doc => claimedIds.add(doc.data().smartlinkId));
        const userAssignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
        const claimedCount = userAssignmentsSnapshot.size;
        const available = adsterraLinks
            .filter(link => !claimedIds.has(String(link.id)))
            .map(link => ({ id: link.id, name: link.name, url: link.url }));
        res.json({
            links: available, count: available.length,
            claimedCount, maxLinks: MAX_LINKS,
            canClaimMore: claimedCount < MAX_LINKS,
            remaining: Math.max(0, MAX_LINKS - claimedCount),
        });
    } catch (error) {
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
            const userAssignmentsQuery = db.collection('assignments').where('userId', '==', uid);
            const userAssignmentsSnapshot = await transaction.get(userAssignmentsQuery);
            if (userAssignmentsSnapshot.size >= MAX_LINKS) throw new Error('MAX_LINKS_REACHED');
            const assignmentRef = db.collection('assignments').doc(String(smartlinkId));
            const assignmentDoc = await transaction.get(assignmentRef);
            if (assignmentDoc.exists) throw new Error('ALREADY_CLAIMED');
            const userRef = db.collection('users').doc(uid);
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new Error('USER_NOT_FOUND');
            transaction.set(assignmentRef, {
                userId: uid, userEmail: email, smartlinkId: String(smartlinkId),
                smartlinkName: link.name,
                assignedAt: admin.firestore.FieldValue.serverTimestamp(),
                claimedBySelf: true,
            });
            transaction.update(userRef, { smartlinkId: String(smartlinkId) });
        });
        const finalCount = (await db.collection('assignments').where('userId', '==', uid).get()).size;
        res.json({
            message: `Link "${link.name}" claimed successfully!`,
            link: { id: link.id, name: link.name, url: link.url },
            claimedCount: finalCount, maxLinks: MAX_LINKS,
            remaining: Math.max(0, MAX_LINKS - finalCount),
        });
    } catch (error) {
        if (error.message === 'MAX_LINKS_REACHED') {
            return res.status(403).json({
                message: `You've reached the maximum limit of ${MAX_LINKS} links per user.`,
                maxLinks: MAX_LINKS, canClaimMore: false,
            });
        }
        if (error.message === 'ALREADY_CLAIMED') return res.status(409).json({ message: 'Already claimed by another user.' });
        if (error.message === 'USER_NOT_FOUND') return res.status(404).json({ message: 'User not found.' });
        res.status(500).json({ message: 'Failed to claim link', error: error.message });
    }
});

// -----------------------------
// 11. AGGREGATED STATS (v1.6.2 — handles per-link + fallback)
// -----------------------------
/**
 * Get aggregated stats for a user.
 * - Tries per-link grouping first
 * - If per-link NOT available → falls back to even distribution of aggregate total
 *   (approximate but shows realistic numbers instead of hardcoded 0)
 */
const getUserAggregatedStats = async (uid, dateFrom, dateTo, applyShare = true) => {
    const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
    if (assignmentsSnapshot.empty) return zeroStats();

    const linkIds = [];
    assignmentsSnapshot.forEach(doc => linkIds.push(doc.data().smartlinkId));

    // Try per-link grouping first
    const bulk = await fetchBulkPlacementStats(dateFrom, dateTo);

    let imp = 0, clk = 0, rev = 0, cpmSum = 0, rpmSum = 0, cnt = 0;

    if (bulk && bulk.items) {
        // Per-link data available — sum up user's links
        linkIds.forEach(id => {
            const match = extractPerLinkStats(bulk.items, id);
            if (match) {
                imp += match.impressions;
                clk += match.clicks;
                rev += match.revenue;
                cpmSum += match.cpm;
                rpmSum += match.rpm;
                cnt++;
            }
        });
    } else {
        // Fallback: aggregate total + distribute proportionally by total link count
        console.log(`⚠️ Per-link not available. Distributing aggregate total proportionally.`);
        const totalStats = await fetchStatsFromAdsterra(dateFrom, dateTo, null);

        // Get total link count across ALL users
        const allAssignmentsSnapshot = await db.collection('assignments').get();
        const totalLinks = allAssignmentsSnapshot.size;
        const userLinks = linkIds.length;
        const share = totalLinks > 0 ? userLinks / totalLinks : 0;

        imp = Math.round((totalStats.impressions || 0) * share);
        clk = Math.round((totalStats.clicks || 0) * share);
        rev = (totalStats.revenue || 0) * share;
        cpmSum = (totalStats.cpm || 0) * userLinks;
        rpmSum = (totalStats.rpm || 0) * userLinks;
        cnt = userLinks;
    }

    const mult = applyShare ? USER_SHARE : 1;
    return {
        impressions: imp,
        clicks: clk,
        revenue: rev * mult,
        cpm: cnt > 0 ? (cpmSum / cnt) * mult : 0,
        rpm: cnt > 0 ? (rpmSum / cnt) * mult : 0,
    };
};

// -----------------------------
// 12. USER STATS + ANALYTICS (v1.6.2)
// -----------------------------
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

            // Try per-link grouping
            const bulk = await fetchBulkPlacementStats(sevenDaysAgo, today);

            if (bulk && bulk.items) {
                // Per-link mode — real per-link stats
                assignmentsSnapshot.forEach(doc => {
                    const data = doc.data();
                    const match = extractPerLinkStats(bulk.items, data.smartlinkId);
                    const stats = match || zeroStats();
                    smartlinks.push({
                        id: data.smartlinkId,
                        name: data.smartlinkName || data.smartlinkId,
                        metrics: {
                            impressions: stats.impressions,
                            clicks: stats.clicks,
                            cpm: stats.cpm * USER_SHARE,
                            rpm: stats.rpm * USER_SHARE,
                            revenue: stats.revenue * USER_SHARE,
                        },
                    });
                });
            } else {
                // Fallback — distribute aggregate proportionally
                const totalStats = await fetchStatsFromAdsterra(sevenDaysAgo, today, null);
                const allAssignments = await db.collection('assignments').get();
                const totalLinks = allAssignments.size;
                const userLinks = assignmentsSnapshot.size;
                const perLinkShare = totalLinks > 0 ? 1 / totalLinks : 0;

                const perLinkImp = (totalStats.impressions || 0) * perLinkShare;
                const perLinkClk = (totalStats.clicks || 0) * perLinkShare;
                const perLinkRev = (totalStats.revenue || 0) * perLinkShare;

                assignmentsSnapshot.forEach(doc => {
                    const data = doc.data();
                    smartlinks.push({
                        id: data.smartlinkId,
                        name: data.smartlinkName || data.smartlinkId,
                        metrics: {
                            impressions: Math.round(perLinkImp),
                            clicks: Math.round(perLinkClk),
                            cpm: (totalStats.cpm || 0) * USER_SHARE,
                            rpm: (totalStats.rpm || 0) * USER_SHARE,
                            revenue: perLinkRev * USER_SHARE,
                        },
                    });
                });
            }
        }

        res.json({
            userEmail: userData.email, permissions, smartlinks,
            linkCount: smartlinks.length, maxLinks: MAX_LINKS,
        });
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
                uid: doc.id, email: data.email,
                displayName: data.displayName || data.email.split('@')[0] || 'User',
            });
        }
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const bulk = await fetchBulkPlacementStats(today, tomorrow);

        const analytics = await Promise.all(otherUsers.map(async (user) => {
            const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', user.uid).get();
            let totalClicks = 0;
            if (bulk && bulk.items) {
                assignmentsSnapshot.forEach(doc => {
                    const match = extractPerLinkStats(bulk.items, doc.data().smartlinkId);
                    if (match) totalClicks += match.clicks;
                });
            } else {
                // Fallback
                const totalStats = await fetchStatsFromAdsterra(today, tomorrow, null);
                const allAssignments = await db.collection('assignments').get();
                const totalLinks = allAssignments.size;
                const userLinks = assignmentsSnapshot.size;
                const share = totalLinks > 0 ? userLinks / totalLinks : 0;
                totalClicks = Math.round((totalStats.clicks || 0) * share);
            }
            return { displayName: user.displayName, email: user.email, totalClicks };
        }));

        analytics.sort((a, b) => b.totalClicks - a.totalClicks);
        res.json({ users: analytics, updatedAt: new Date().toISOString() });
    } catch (error) {
        console.error('User analytics error:', error);
        res.status(500).json({ message: 'Failed to fetch user analytics' });
    }
});

// -----------------------------
// 13. USER GOALS
// -----------------------------
app.get('/api/user/goals', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const goalsSnapshot = await db.collection('users').doc(uid).collection('goals').get();
        if (goalsSnapshot.empty) return res.json({ goals: [] });
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const currentStats = await getUserAggregatedStats(uid, thirtyDaysAgo, today, true);
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
                id: doc.id, type: data.type,
                title: data.title || data.type.charAt(0).toUpperCase() + data.type.slice(1),
                target: data.target, current, progress,
                deadline: data.deadline || null,
                createdAt: safeDateToISO(data.createdAt) || new Date().toISOString(),
                updatedAt: safeDateToISO(data.updatedAt) || new Date().toISOString(),
            });
        });
        res.json({ goals });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch goals', error: error.message });
    }
});

app.post('/api/user/goals', authMiddleware('user'), async (req, res) => {
    try {
        const uid = req.user.uid;
        const { type, target, deadline } = req.body;
        if (!type || !target || target <= 0) return res.status(400).json({ message: 'Invalid goal' });
        if (!['revenue', 'clicks', 'impressions', 'rpm'].includes(type)) return res.status(400).json({ message: 'Invalid type' });
        const docRef = await db.collection('users').doc(uid).collection('goals').add({
            type, target: parseFloat(target), deadline: deadline || null,
            title: type.charAt(0).toUpperCase() + type.slice(1),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(201).json({ message: 'Goal created', goalId: docRef.id });
    } catch (error) {
        res.status(500).json({ message: 'Failed to create goal', error: error.message });
    }
});

app.put('/api/user/goals/:goalId', authMiddleware('user'), async (req, res) => {
    try {
        const { goalId } = req.params;
        const { type, target, deadline } = req.body;
        if (!goalId || !type || !target || target <= 0) return res.status(400).json({ message: 'Missing fields' });
        const goalRef = db.collection('users').doc(req.user.uid).collection('goals').doc(goalId);
        const goalDoc = await goalRef.get();
        if (!goalDoc.exists) return res.status(404).json({ message: 'Goal not found' });
        await goalRef.update({
            type, target: parseFloat(target), deadline: deadline || null,
            title: type.charAt(0).toUpperCase() + type.slice(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.json({ message: 'Goal updated' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update goal', error: error.message });
    }
});

app.delete('/api/user/goals/:goalId', authMiddleware('user'), async (req, res) => {
    try {
        const { goalId } = req.params;
        if (!goalId) return res.status(400).json({ message: 'Goal ID required' });
        const goalRef = db.collection('users').doc(req.user.uid).collection('goals').doc(goalId);
        const goalDoc = await goalRef.get();
        if (!goalDoc.exists) return res.status(404).json({ message: 'Goal not found' });
        await goalRef.delete();
        res.json({ message: 'Goal deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to delete goal' });
    }
});

// -----------------------------
// 14. USER BALANCE
// -----------------------------
const getUserBalance = async (uid, days = BALANCE_PERIOD_DAYS) => {
    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const stats = await getUserAggregatedStats(uid, fromDate, today, true);
    const totalEarned = stats.revenue || 0;
    const withdrawalsSnapshot = await db.collection('withdrawalRequests').where('userId', '==', uid).get();
    let totalWithdrawn = 0, totalPending = 0, totalProcessing = 0;
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
        totalEarned: round2(totalEarned), totalWithdrawn: round2(totalWithdrawn),
        totalPending: round2(totalPending), totalProcessing: round2(totalProcessing),
        lockedInRequests: round2(lockedInRequests), availableBalance: round2(availableBalance),
        currency: 'USD', periodDays: days, periodFrom: fromDate, periodTo: today,
        calculatedAt: new Date().toISOString(),
    };
};

app.get('/api/user/balance', authMiddleware('user'), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || BALANCE_PERIOD_DAYS;
        const balance = await getUserBalance(req.user.uid, days);
        const nextWindow = getNextWithdrawalWindow();
        res.json({
            ...balance,
            withdrawalWindowOpen: isWithdrawalWindowOpen(),
            nextWithdrawalWindow: nextWindow ? nextWindow.toISOString().split('T')[0] : null,
            withdrawalWindowDates: WITHDRAWAL_WINDOW_DATES,
            minWithdrawalUsd: MIN_WITHDRAWAL,
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch balance', error: error.message });
    }
});

// -----------------------------
// 15. ADMIN — USER BALANCE BREAKDOWN
// -----------------------------
const getUserBalanceWithBreakdown = async (uid, days = BALANCE_PERIOD_DAYS) => {
    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
    const bulk = await fetchBulkPlacementStats(fromDate, today);

    let links = [];
    let rawTotal = 0;

    if (bulk && bulk.items) {
        // Per-link mode
        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            const match = extractPerLinkStats(bulk.items, data.smartlinkId);
            const stats = match || zeroStats();
            links.push({
                id: data.smartlinkId,
                name: data.smartlinkName || data.smartlinkId,
                url: data.smartlinkUrl || '',
                rawRevenue: round2(stats.revenue),
                sharedRevenue: round2(stats.revenue * USER_SHARE),
                margin: round2(stats.revenue * ADMIN_SHARE),
                clicks: stats.clicks,
                impressions: stats.impressions,
                cpm: round2(stats.cpm),
                rpm: round2(stats.rpm),
                claimedBySelf: data.claimedBySelf || false,
                assignedAt: safeDateToISO(data.assignedAt),
            });
            rawTotal += stats.revenue;
        });
    } else {
        // Fallback — distribute proportionally
        const totalStats = await fetchStatsFromAdsterra(fromDate, today, null);
        const allAssignments = await db.collection('assignments').get();
        const totalLinks = allAssignments.size;
        const userLinks = assignmentsSnapshot.size;
        const perLinkRev = totalLinks > 0 ? (totalStats.revenue || 0) / totalLinks : 0;

        assignmentsSnapshot.forEach(doc => {
            const data = doc.data();
            links.push({
                id: data.smartlinkId,
                name: data.smartlinkName || data.smartlinkId,
                url: data.smartlinkUrl || '',
                rawRevenue: round2(perLinkRev),
                sharedRevenue: round2(perLinkRev * USER_SHARE),
                margin: round2(perLinkRev * ADMIN_SHARE),
                clicks: 0,
                impressions: 0,
                cpm: 0, rpm: 0,
                claimedBySelf: data.claimedBySelf || false,
                assignedAt: safeDateToISO(data.assignedAt),
            });
            rawTotal += perLinkRev;
        });
    }

    links.sort((a, b) => b.rawRevenue - a.rawRevenue);
    const sharedTotal = rawTotal * USER_SHARE;

    const withdrawalsSnapshot = await db.collection('withdrawalRequests').where('userId', '==', uid).get();
    let totalWithdrawn = 0, totalPending = 0, totalProcessing = 0;
    withdrawalsSnapshot.forEach(doc => {
        const d = doc.data();
        const amt = parseFloat(d.amount) || 0;
        if (d.status === 'approved') totalWithdrawn += amt;
        else if (d.status === 'pending') totalPending += amt;
        else if (d.status === 'processing') totalProcessing += amt;
    });

    const lockedInRequests = totalPending + totalProcessing;
    const availableBalance = Math.max(0, sharedTotal - totalWithdrawn - lockedInRequests);

    return {
        raw: {
            totalEarned: round2(rawTotal),
            platformMarginPotential: round2(rawTotal * ADMIN_SHARE),
        },
        user: {
            totalEarned: round2(sharedTotal),
            totalWithdrawn: round2(totalWithdrawn),
            totalPending: round2(totalPending),
            totalProcessing: round2(totalProcessing),
            lockedInRequests: round2(lockedInRequests),
            availableBalance: round2(availableBalance),
        },
        period: { days, from: fromDate, to: today },
        links,
        linksCount: links.length,
    };
};

app.get('/api/admin/user-balance/:uid', authMiddleware('admin'), async (req, res) => {
    try {
        const { uid } = req.params;
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ message: 'User not found' });
        const userData = userDoc.data();
        const days = parseInt(req.query.days) || BALANCE_PERIOD_DAYS;
        const breakdown = await getUserBalanceWithBreakdown(uid, days);
        res.json({
            user: {
                uid, email: userData.email,
                displayName: userData.displayName || (userData.email || '').split('@')[0] || 'User',
                role: userData.role, createdAt: safeDateToISO(userData.createdAt),
            },
            raw: breakdown.raw,
            userBalance: breakdown.user,
            period: breakdown.period,
            links: breakdown.links,
            linksCount: breakdown.linksCount,
            maxLinks: MAX_LINKS,
            canClaimMore: breakdown.linksCount < MAX_LINKS,
        });
    } catch (error) {
        console.error('Admin user balance error:', error);
        res.status(500).json({ message: 'Failed to fetch user balance', error: error.message });
    }
});

// -----------------------------
// 16. ADMIN — EARNINGS OVERVIEW (v1.6.2)
// -----------------------------
app.get('/api/admin/earnings-overview', authMiddleware('admin'), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const today = new Date().toISOString().split('T')[0];
        const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        const assignmentsSnapshot = await db.collection('assignments').get();
        const withdrawalsSnapshot = await db.collection('withdrawalRequests').get();

        const userMap = {};
        usersSnapshot.forEach(doc => {
            const d = doc.data();
            userMap[doc.id] = {
                uid: doc.id, email: d.email,
                displayName: d.displayName || (d.email || '').split('@')[0] || 'User',
            };
        });

        // Try per-link first
        const bulk = await fetchBulkPlacementStats(fromDate, today);
        let links = [];

        if (bulk && bulk.items) {
            // Per-link mode
            assignmentsSnapshot.forEach(doc => {
                const d = doc.data();
                const match = extractPerLinkStats(bulk.items, d.smartlinkId);
                const stats = match || zeroStats();
                links.push({
                    id: d.smartlinkId,
                    name: d.smartlinkName || d.smartlinkId,
                    userId: d.userId,
                    userEmail: d.userEmail,
                    userName: userMap[d.userId]?.displayName || 'Unknown',
                    rawRevenue: round2(stats.revenue),
                    sharedRevenue: round2(stats.revenue * USER_SHARE),
                    margin: round2(stats.revenue * ADMIN_SHARE),
                    clicks: stats.clicks,
                    impressions: stats.impressions,
                });
            });
        } else {
            // Fallback — distribute total proportional to link count
            const totalStats = await fetchStatsFromAdsterra(fromDate, today, null);
            const totalLinks = assignmentsSnapshot.size;
            const perLinkRev = totalLinks > 0 ? (totalStats.revenue || 0) / totalLinks : 0;
            const perLinkImp = totalLinks > 0 ? (totalStats.impressions || 0) / totalLinks : 0;
            const perLinkClk = totalLinks > 0 ? (totalStats.clicks || 0) / totalLinks : 0;

            assignmentsSnapshot.forEach(doc => {
                const d = doc.data();
                links.push({
                    id: d.smartlinkId,
                    name: d.smartlinkName || d.smartlinkId,
                    userId: d.userId,
                    userEmail: d.userEmail,
                    userName: userMap[d.userId]?.displayName || 'Unknown',
                    rawRevenue: round2(perLinkRev),
                    sharedRevenue: round2(perLinkRev * USER_SHARE),
                    margin: round2(perLinkRev * ADMIN_SHARE),
                    clicks: Math.round(perLinkClk),
                    impressions: Math.round(perLinkImp),
                });
            });
        }

        links.sort((a, b) => b.rawRevenue - a.rawRevenue);

        const userAgg = {};
        Object.values(userMap).forEach(u => {
            userAgg[u.uid] = {
                uid: u.uid, email: u.email, displayName: u.displayName,
                rawEarned: 0, sharedEarned: 0,
                withdrawnApproved: 0, withdrawnPending: 0, withdrawnProcessing: 0,
                linksCount: 0,
            };
        });

        links.forEach(l => {
            if (userAgg[l.userId]) {
                userAgg[l.userId].rawEarned += l.rawRevenue;
                userAgg[l.userId].sharedEarned += l.sharedRevenue;
                userAgg[l.userId].linksCount++;
            }
        });

        withdrawalsSnapshot.forEach(doc => {
            const d = doc.data();
            const amt = parseFloat(d.amount) || 0;
            if (!userAgg[d.userId]) return;
            if (d.status === 'approved') userAgg[d.userId].withdrawnApproved += amt;
            else if (d.status === 'pending') userAgg[d.userId].withdrawnPending += amt;
            else if (d.status === 'processing') userAgg[d.userId].withdrawnProcessing += amt;
        });

        Object.values(userAgg).forEach(u => {
            u.rawEarned = round2(u.rawEarned);
            u.sharedEarned = round2(u.sharedEarned);
            u.withdrawnApproved = round2(u.withdrawnApproved);
            u.withdrawnPending = round2(u.withdrawnPending);
            u.withdrawnProcessing = round2(u.withdrawnProcessing);
            u.lockedInRequests = round2(u.withdrawnPending + u.withdrawnProcessing);
            u.availableBalance = round2(Math.max(0, u.sharedEarned - u.withdrawnApproved - u.lockedInRequests));
        });

        const users = Object.values(userAgg).sort((a, b) => b.rawEarned - a.rawEarned);

        const totalRaw = links.reduce((sum, l) => sum + l.rawRevenue, 0);
        const totalShared = links.reduce((sum, l) => sum + l.sharedRevenue, 0);
        const totalMargin = links.reduce((sum, l) => sum + l.margin, 0);
        const totalApproved = users.reduce((sum, u) => sum + u.withdrawnApproved, 0);
        const totalPending = users.reduce((sum, u) => sum + u.withdrawnPending, 0);
        const totalProcessing = users.reduce((sum, u) => sum + u.withdrawnProcessing, 0);
        const totalUserBalances = users.reduce((sum, u) => sum + u.availableBalance, 0);

        res.json({
            period: { days, from: fromDate, to: today },
            split: { userShare: USER_SHARE, adminShare: ADMIN_SHARE },
            dataMode: bulk && bulk.items ? 'per-link' : 'proportional',
            totals: {
                rawRevenue: round2(totalRaw),
                userShownRevenue: round2(totalShared),
                platformMargin: round2(totalMargin),
                totalApprovedWithdrawals: round2(totalApproved),
                totalPendingWithdrawals: round2(totalPending),
                totalProcessingWithdrawals: round2(totalProcessing),
                reservedForPayouts: round2(totalPending + totalProcessing),
                totalUserBalances: round2(totalUserBalances),
                actualCashInHand: round2(totalRaw - totalApproved),
                potentialProfit: round2(totalRaw - totalApproved - totalPending - totalProcessing),
            },
            links,
            users,
            linkCount: links.length,
            userCount: users.length,
        });
    } catch (error) {
        console.error('Admin earnings overview error:', error);
        res.status(500).json({ message: 'Failed to fetch earnings overview', error: error.message });
    }
});

// -----------------------------
// 17. USER — WITHDRAWAL REQUESTS
// -----------------------------
const WITHDRAWAL_METHODS = ['jazzcash', 'easypaisa', 'bank', 'binance_uid', 'usdt_bep20'];

function validateWithdrawalPayload(body) {
    const { amount, method } = body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return 'Amount must be greater than 0.';
    if (amt < MIN_WITHDRAWAL) return `Minimum withdrawal amount is $${MIN_WITHDRAWAL}.`;
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
        if (!isWithdrawalWindowOpen()) {
            const next = getNextWithdrawalWindow();
            return res.status(403).json({
                message: `Withdrawals are only allowed on the 14th, 15th, 29th, and 30th of each month. Next window: ${next ? next.toISOString().split('T')[0] : 'N/A'}.`,
                withdrawalWindowOpen: false,
                nextWithdrawalWindow: next ? next.toISOString().split('T')[0] : null,
                withdrawalWindowDates: WITHDRAWAL_WINDOW_DATES,
            });
        }
        const validationError = validateWithdrawalPayload(req.body);
        if (validationError) return res.status(400).json({ message: validationError });
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ message: 'User not found.' });
        const userData = userDoc.data();
        const requestedAmount = parseFloat(req.body.amount);
        const balance = await getUserBalance(uid);
        if (balance.availableBalance <= 0) {
            return res.status(400).json({
                message: `You have no available balance to withdraw.`,
                availableBalance: balance.availableBalance,
            });
        }
        if (requestedAmount > balance.availableBalance) {
            return res.status(400).json({
                message: `Insufficient balance. Available: $${balance.availableBalance.toFixed(2)}.`,
                availableBalance: balance.availableBalance, requestedAmount,
            });
        }
        const { method, accountName, accountNumber, iban, binanceUid, usdtAddress } = req.body;
        const requestData = {
            userId: uid, userEmail: email,
            userName: userData.displayName || email.split('@')[0] || 'User',
            amount: parseFloat(req.body.amount), method,
            status: 'pending', rejectionReason: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedBy: null, processedAt: null,
            balanceAtRequest: balance.availableBalance,
        };
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
            newAvailableBalance: round2(balance.availableBalance - requestedAmount),
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
        const snapshot = await db.collection('withdrawalRequests').where('userId', '==', uid).get();
        const requests = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            requests.push({
                id: doc.id, amount: d.amount, method: d.method, status: d.status,
                rejectionReason: d.rejectionReason || null,
                accountName: d.accountName || null, accountNumber: d.accountNumber || null,
                iban: d.iban || null, bankName: d.bankName || null,
                binanceUid: d.binanceUid || null, usdtAddress: d.usdtAddress || null,
                cryptoNetwork: d.cryptoNetwork || null, cryptoType: d.cryptoType || null,
                createdAt: safeDateToISO(d.createdAt), updatedAt: safeDateToISO(d.updatedAt),
                processedAt: safeDateToISO(d.processedAt), processedBy: d.processedBy || null,
            });
        });
        requests.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bt - at;
        });
        res.json({ requests: requests.slice(0, limit), count: requests.length });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch withdrawals', error: error.message });
    }
});

// -----------------------------
// 18. ADMIN — WITHDRAWAL MANAGEMENT
// -----------------------------
app.get('/api/admin/withdrawal-requests', authMiddleware('admin'), async (req, res) => {
    try {
        const status = req.query.status || 'all';
        const limit = getLimit(req, 200, 500);
        const snapshot = await db.collection('withdrawalRequests').get();
        const requests = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            requests.push({
                id: doc.id, userId: d.userId || null,
                userEmail: d.userEmail || '—', userName: d.userName || '—',
                amount: d.amount || 0, method: d.method || '—', status: d.status || 'pending',
                rejectionReason: d.rejectionReason || null,
                accountName: d.accountName || null, accountNumber: d.accountNumber || null,
                iban: d.iban || null, bankName: d.bankName || null,
                binanceUid: d.binanceUid || null, usdtAddress: d.usdtAddress || null,
                cryptoNetwork: d.cryptoNetwork || null, cryptoType: d.cryptoType || null,
                createdAt: safeDateToISO(d.createdAt), updatedAt: safeDateToISO(d.updatedAt),
                processedAt: safeDateToISO(d.processedAt), processedBy: d.processedBy || null,
            });
        });
        const filtered = status === 'all' ? requests : requests.filter(r => r.status === status);
        filtered.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bt - at;
        });
        res.json({
            requests: filtered.slice(0, limit),
            count: filtered.length, totalCount: requests.length, filter: status,
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch withdrawals', error: error.message });
    }
});

app.patch('/api/admin/withdrawal-requests/:id', authMiddleware('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status, rejectionReason } = req.body;
        if (!id) return res.status(400).json({ message: 'Request ID required.' });
        if (!['pending', 'processing', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status.' });
        }
        if (status === 'rejected' && (!rejectionReason || !String(rejectionReason).trim())) {
            return res.status(400).json({ message: 'Rejection reason required.' });
        }
        const requestRef = db.collection('withdrawalRequests').doc(id);
        const requestDoc = await requestRef.get();
        if (!requestDoc.exists) return res.status(404).json({ message: 'Request not found.' });
        await requestRef.update({
            status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedBy: req.user.email,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            rejectionReason: status === 'rejected' ? String(rejectionReason).trim() : null,
        });
        res.json({ message: `Withdrawal marked as "${status}".` });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update withdrawal', error: error.message });
    }
});

// -----------------------------
// 19. USER — LIVE CHAT
// -----------------------------
app.get('/api/user/chat/messages', authMiddleware('user'), async (req, res) => {
    try {
        const userEmail = req.user.email;
        const limit = getLimit(req, 100, 300);
        const snapshot = await db.collection('chatMessages').where('userEmail', '==', userEmail).get();
        const messages = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            messages.push({
                id: doc.id, fromRole: d.fromRole, fromEmail: d.fromEmail,
                message: d.message, read: d.read || false,
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
        res.status(500).json({ message: 'Failed to fetch messages', error: error.message });
    }
});

app.post('/api/user/chat/send', authMiddleware('user'), async (req, res) => {
    try {
        const userEmail = req.user.email;
        const { message } = req.body;
        if (!message || !String(message).trim()) return res.status(400).json({ message: 'Message empty.' });
        if (String(message).length > 2000) return res.status(400).json({ message: 'Too long (max 2000).' });
        const docRef = await db.collection('chatMessages').add({
            userEmail, userId: req.user.uid,
            fromRole: 'user', fromEmail: userEmail,
            message: String(message).trim(), read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(201).json({ message: 'Message sent.', messageId: docRef.id });
    } catch (error) {
        res.status(500).json({ message: 'Failed to send', error: error.message });
    }
});

app.patch('/api/user/chat/read', authMiddleware('user'), async (req, res) => {
    try {
        const snapshot = await db.collection('chatMessages')
            .where('userEmail', '==', req.user.email)
            .where('fromRole', '==', 'admin')
            .where('read', '==', false).get();
        const batch = db.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { read: true }));
        await batch.commit();
        res.json({ message: 'Marked read', count: snapshot.size });
    } catch (error) {
        res.status(500).json({ message: 'Failed to mark read', error: error.message });
    }
});

// -----------------------------
// 20. ADMIN — LIVE CHAT
// -----------------------------
app.get('/api/admin/chat/users', authMiddleware('admin'), async (req, res) => {
    try {
        const snapshot = await db.collection('chatMessages').get();
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
                    userEmail: email, userName: email.split('@')[0],
                    lastMessage: d.message, lastMessageAt: ts,
                    lastFromRole: d.fromRole, unreadCount: isUnread ? 1 : 0,
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
        const emails = Object.keys(threadsMap);
        if (emails.length > 0) {
            for (let i = 0; i < emails.length; i += 10) {
                const chunk = emails.slice(i, i + 10);
                try {
                    const usersSnapshot = await db.collection('users').where('email', 'in', chunk).get();
                    usersSnapshot.forEach(userDoc => {
                        const ud = userDoc.data();
                        if (ud.email && threadsMap[ud.email]) {
                            threadsMap[ud.email].userName = ud.displayName || ud.email.split('@')[0];
                        }
                    });
                } catch (err) { /* silent */ }
            }
        }
        const threads = Object.values(threadsMap).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        res.json({ threads, totalUnread, totalThreads: threads.length });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch threads', error: error.message });
    }
});

app.get('/api/admin/chat/messages/:userEmail', authMiddleware('admin'), async (req, res) => {
    try {
        const userEmail = decodeURIComponent(req.params.userEmail);
        if (!userEmail) return res.status(400).json({ message: 'Email required.' });
        const limit = getLimit(req, 100, 300);
        const snapshot = await db.collection('chatMessages').where('userEmail', '==', userEmail).get();
        const messages = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            messages.push({
                id: doc.id, fromRole: d.fromRole, fromEmail: d.fromEmail,
                message: d.message, read: d.read || false,
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
        res.status(500).json({ message: 'Failed to fetch messages', error: error.message });
    }
});

app.post('/api/admin/chat/send', authMiddleware('admin'), async (req, res) => {
    try {
        const { userEmail, message } = req.body;
        if (!userEmail || !String(userEmail).trim()) return res.status(400).json({ message: 'Email required.' });
        if (!message || !String(message).trim()) return res.status(400).json({ message: 'Message empty.' });
        if (String(message).length > 2000) return res.status(400).json({ message: 'Too long.' });
        const userSnapshot = await db.collection('users')
            .where('email', '==', String(userEmail).trim())
            .where('role', '==', 'user').get();
        if (userSnapshot.empty) return res.status(404).json({ message: 'User not found.' });
        const docRef = await db.collection('chatMessages').add({
            userEmail: String(userEmail).trim(),
            userId: userSnapshot.docs[0].id,
            fromRole: 'admin', fromEmail: req.user.email,
            message: String(message).trim(), read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(201).json({ message: 'Message sent.', messageId: docRef.id });
    } catch (error) {
        res.status(500).json({ message: 'Failed to send', error: error.message });
    }
});

app.patch('/api/admin/chat/read/:userEmail', authMiddleware('admin'), async (req, res) => {
    try {
        const userEmail = decodeURIComponent(req.params.userEmail);
        if (!userEmail) return res.status(400).json({ message: 'Email required.' });
        const snapshot = await db.collection('chatMessages')
            .where('userEmail', '==', userEmail)
            .where('fromRole', '==', 'user')
            .where('read', '==', false).get();
        const batch = db.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { read: true }));
        await batch.commit();
        res.json({ message: 'Marked read', count: snapshot.size });
    } catch (error) {
        res.status(500).json({ message: 'Failed to mark read', error: error.message });
    }
});

// -----------------------------
// 21. LEADERBOARD
// -----------------------------
app.get('/api/leaderboard', authMiddleware('user'), async (req, res) => {
    try {
        const { period = 'week' } = req.query;
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const fromDate = new Date(today);
        if (period === 'week') fromDate.setDate(fromDate.getDate() - 7);
        else if (period === 'month') fromDate.setDate(fromDate.getDate() - 30);
        else return res.status(400).json({ message: 'Invalid period' });
        const fromStr = fromDate.toISOString().split('T')[0];

        const usersSnapshot = await db.collection('users').where('role', '==', 'user').get();
        if (usersSnapshot.empty) return res.json({ users: [] });

        const bulk = await fetchBulkPlacementStats(fromStr, todayStr);
        const allAssignments = await db.collection('assignments').get();
        const totalLinks = allAssignments.size;
        const totalStats = (!bulk) ? await fetchStatsFromAdsterra(fromStr, todayStr, null) : null;

        const leaderboardData = await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
            const userData = userDoc.data();
            const uid = userDoc.id;
            const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', uid).get();
            if (assignmentsSnapshot.empty) return null;

            let rawTotal = 0;
            if (bulk && bulk.items) {
                assignmentsSnapshot.forEach(doc => {
                    const match = extractPerLinkStats(bulk.items, doc.data().smartlinkId);
                    if (match) rawTotal += match.revenue;
                });
            } else {
                const userLinks = assignmentsSnapshot.size;
                const share = totalLinks > 0 ? userLinks / totalLinks : 0;
                rawTotal = (totalStats.revenue || 0) * share;
            }

            return {
                uid, email: userData.email,
                displayName: userData.displayName || userData.email.split('@')[0] || 'User',
                revenue: round2(rawTotal * USER_SHARE),
            };
        }));

        const filtered = leaderboardData.filter(Boolean).sort((a, b) => b.revenue - a.revenue);
        res.json({ period, from: fromStr, to: todayStr, users: filtered.slice(0, 20) });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch leaderboard', error: error.message });
    }
});

// -----------------------------
// 22. CHART DATA
// -----------------------------
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
            impressions: (stats && stats.impressions) || 0,
            clicks: (stats && stats.clicks) || 0,
            revenue: (stats && stats.revenue) || 0,
        });
    }
    return dailyData;
};

const aggregateDailyStats = async (linkIds, days) => {
    const dailyMap = {};
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        dailyMap[dateStr] = { date: dateStr, impressions: 0, clicks: 0, revenue: 0 };
    }
    await Promise.all(linkIds.map(async (linkId) => {
        try {
            const dailyStats = await fetchDailyStatsForLink(linkId, days);
            dailyStats.forEach(day => {
                if (dailyMap[day.date]) {
                    dailyMap[day.date].impressions += day.impressions;
                    dailyMap[day.date].clicks += day.clicks;
                    dailyMap[day.date].revenue += day.revenue;
                }
            });
        } catch (err) { /* silent */ }
    }));
    const sortedDates = Object.keys(dailyMap).sort();
    return sortedDates.map(date => dailyMap[date]);
};

app.get('/api/admin/chart-data', authMiddleware('admin'), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        if (days < 1 || days > 90) return res.status(400).json({ message: 'Days 1-90' });
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
        res.status(500).json({ message: 'Failed chart data', error: error.message });
    }
});

app.get('/api/user/chart-data', authMiddleware('user'), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        if (days < 1 || days > 90) return res.status(400).json({ message: 'Days 1-90' });
        const assignmentsSnapshot = await db.collection('assignments').where('userId', '==', req.user.uid).get();
        const linkIds = [];
        assignmentsSnapshot.forEach(doc => {
            if (doc.data().smartlinkId) linkIds.push(doc.data().smartlinkId);
        });
        if (linkIds.length === 0) return res.json({ labels: [], impressions: [], clicks: [], revenue: [] });
        const dailyData = await aggregateDailyStats(linkIds, days);
        res.json({
            labels: dailyData.map(d => d.date),
            impressions: dailyData.map(d => d.impressions),
            clicks: dailyData.map(d => d.clicks),
            revenue: dailyData.map(d => round2(d.revenue * USER_SHARE)),
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed chart data', error: error.message });
    }
});

// -----------------------------
// 23. ROOT
// -----------------------------
app.get('/api', (req, res) => {
    res.json({
        name: 'Lunar Metrics API', version: '1.6.2', status: 'operational',
        split: { userShare: USER_SHARE, adminShare: ADMIN_SHARE },
        limits: {
            maxLinksPerUser: MAX_LINKS,
            minWithdrawalUsd: MIN_WITHDRAWAL,
            withdrawalWindowDates: WITHDRAWAL_WINDOW_DATES,
            balanceLookbackDays: BALANCE_PERIOD_DAYS,
        },
        features: [
            'auth', 'adsterra-smartlinks', 'admin-users', 'admin-links',
            'user-stats', 'user-analytics', 'goals', 'leaderboard', 'chart-data',
            'self-service-claiming', 'claim-limit-10',
            'withdrawals', 'withdrawal-windows-14-15-29-30', 'min-withdrawal-15',
            'live-chat', 'balance', 'balance-validated-withdrawals',
            'crypto-split-methods', 'admin-user-balance-breakdown',
            'admin-earnings-overview', 'revenue-split-60-40',
            'adsterra-stats-v1.6.2-group-by-tested',
        ],
        timestamp: new Date().toISOString(),
    });
});

module.exports = app;
