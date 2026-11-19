const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tiktokLib = require('tiktok-live-connector');
const path = require('path');

if (tiktokLib.SignConfig && process.env.SIGN_API_KEY) {
    tiktokLib.SignConfig.apiKey = process.env.SIGN_API_KEY.trim();
}

const TikTokConnectorClass =
    tiktokLib.TikTokLiveConnection ||
    tiktokLib.WebcastPushConnection ||
    (tiktokLib.default && (tiktokLib.default.TikTokLiveConnection || tiktokLib.default.WebcastPushConnection || tiktokLib.default)) ||
    tiktokLib;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_SEATS = 250;
const ROUND_DURATION = 240; // 4 dakika
const PODIUM_DURATION = 6;  // Tur sonu 6 saniye mezuniyet podyumu

// 9:16 Dikey Telefon Ekranına Sağdan/Soldan Taşmadan Tam Oturan 10 Kademeli Stadyum Amfi (Toplam 250 Sıra)
// Tier 0 (index 0..13) = En Ön Sıra, Tier 9 (index 214..249) = En Arka Sıra
const TIER_COUNTS = [14, 16, 19, 21, 24, 26, 29, 31, 34, 36]; // Toplam = 250
const SEAT_LAYOUT = [];

(function buildAmphitheaterLayout() {
    let idx = 0;
    const maxAngle = 0.52; // ~30° sağ/sol yay: tüm amfi genişliği ±17m içinde kalarak telefona tam sığar
    for (let tier = 0; tier < TIER_COUNTS.length; tier++) {
        const count = TIER_COUNTS[tier];
        const radius = 13.5 + tier * 2.3;
        const y = 0.35 + tier * 0.72;

        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0.5 : i / (count - 1);
            let angle = -maxAngle + t * (maxAngle * 2);
            // Orta koridor boşluğu
            if (angle > -0.042 && angle < 0.042) {
                angle += (angle >= 0 ? 0.036 : -0.036);
            }

            const x = Math.sin(angle) * radius;
            const z = Math.cos(angle) * radius - 10;
            SEAT_LAYOUT.push({
                index: idx++,
                tier,
                x: Number(x.toFixed(2)),
                y: Number(y.toFixed(2)),
                z: Number(z.toFixed(2)),
                rotY: angle + Math.PI
            });
        }
    }
})();

// Çakışmasız Türk İsimleri & Niş Öğrenci Lakapları Havuzu (320+ Benzersiz İsim)
const TURKISH_BOT_NAMES = [
    'Kaan', 'Zeynep', 'Emirhan', 'Elif', 'Arda', 'Defne', 'Mert', 'Ecrin', 'Kerem', 'Asya',
    'Burak', 'Nisa', 'Yusuf', 'Eylül', 'Ege', 'Miray', 'Batuhan', 'Beren', 'Alperen', 'Azra',
    'Caner', 'Selin', 'Onur', 'İrem', 'Taha', 'Melis', 'Baran', 'Duru', 'Umut', 'Ceren',
    'Göktuğ', 'Sude', 'Kuzey', 'Yağmur', 'Doruk', 'Nazlı', 'Poyraz', 'İlayda', 'Çınar', 'Beste',
    'Rüzgar', 'Damla', 'Emre', 'Buse', 'Furkan', 'Simge', 'Oğuzhan', 'Tuana', 'Semih', 'Ebru',
    'Koray', 'Gizem', 'Tolga', 'Hilal', 'Serkan', 'Esra', 'Volkan', 'Cansu', 'Sinan', 'Kübra',
    'Hakan', 'Merve', 'Tarık', 'Büşra', 'Berkay', 'Aleyna', 'Çağatay', 'Dilara', 'Kıvanç', 'Şevval',
    'Ömer', 'Hatice', 'Yiğit', 'Rabia', 'Tuna', 'Nehir', 'Atlas', 'Ada', 'Pars', 'Lina',
    'Karan', 'Masal', 'Aren', 'Ela', 'Miran', 'Öykü', 'Eymen', 'Zümra', 'Ayaz', 'Derin',
    'Metehan', 'Gökçe', 'Enes', 'Begüm', 'Melih', 'Cemre', 'Anıl', 'Sıla', 'Deniz', 'Melisa',
    'Taylan', 'İpek', 'Bora', 'Ece', 'Kubilay', 'Pınar', 'Erhan', 'Derya', 'Cihan', 'Özge',
    'Salih', 'Nihan', 'Yavuz', 'Funda', 'Murat', 'Didem', 'Levent', 'Aslı', 'Kemal', 'Betül',
    'Orhan', 'Şeyma', 'Mustafa', 'Tuğba', 'Ahmet', 'Zehra', 'Mehmet', 'Fatma', 'Ali', 'Ayşe',
    'Hasan', 'Emine', 'Hüseyin', 'Sultan', 'İbrahim', 'Yasemin', 'İsmail', 'Sibel', 'Osman', 'Filiz',
    'Süleyman', 'Arzu', 'Ramazan', 'Gülşen', 'Recep', 'Sevgi', 'Mahmut', 'Neşe', 'Halil', 'Aylin',
    'Eren', 'Berrak', 'Toprak', 'Sena', 'Ulaş', 'Bahar', 'Buğra', 'Burcu', 'Çağrı', 'Hande',
    'Doğukan', 'Pelinsu', 'Erdem', 'Duygu', 'Gökhan', 'Eda', 'Harun', 'Feride', 'İlker', 'Gamze',
    'Kadir', 'Hülya', 'Mazlum', 'İclal', 'Necati', 'Jale', 'Okan', 'Kardelen', 'Polat', 'Lale',
    'Rıdvan', 'Mine', 'Savaş', 'Nazan', 'Taner', 'Oya', 'Ufuk', 'Perihan', 'Veli', 'Rüya',
    'Yakup', 'Serap', 'Zafer', 'Şule', 'Alparslan', 'Tülay', 'Bilal', 'Ülkü', 'Cem', 'Vildan',
    'SınavCanavarı', 'KopyaBükücü', 'ArkaSıraKralı', 'SonDakikaGolü', 'KalemKıran',
    'KantinciAbi', 'GeceKuşu', 'MatematikDehası', 'SözlüKorkusu', 'SilgiTozu',
    'UçluKalem07', 'TeneffüsZili', 'ÖnSıraİneği', 'SınavKaçağı', 'NotAvcısı',
    'FormülÜstadı', 'SoruBükücü', 'ÇaycıHüseyin', 'TostçuErol', 'KantinKuyruğu',
    'KarneCanavarı', 'BütünlemeKralı', 'VizeMagduru', 'FinalBoss', 'KalemUcu',
    'SıraAltıTelefon', 'SilgiFırlatan', 'TahtaSilici', 'NöbetçiÖğrenci', 'YoklamaKaçağı',
    'FizikProfu', 'KimyaBüyücüsü', 'TarihKurdu', 'EdebiyatAşığı', 'GeometriZekası',
    'ZilÇaldıHocam', 'KalemTıraş', 'KareliDefter', 'KırmızıKalem', 'SözlüNotu100',
    'EfsaneKopyacı', 'HızlıKalem', 'SabahçıTayfa', 'ÖğlenciKral', 'MatematikKurdu',
    'TürevBükücü', 'İntegralAvcısı', 'ParagrafCanavarı', 'DenemeŞampiyonu', 'NetAvcısı'
];

const TURKISH_SURNAMES = [
    'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Aydın', 'Öztürk',
    'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek',
    'Polat', 'Erdoğan', 'Yalçın', 'Güneş', 'Bozkurt', 'Bulut', 'Keskin', 'Ünal', 'Turan', 'Gül'
];

let tiktokConnection = null;
let reconnectTimer = null;
let connectedUsername = (process.env.TIKTOK_ROOM_ID || process.env.TIKTOK_USERNAME || '').replace('@', '').trim();
let connectionStatus = 'Bağlantı bekleniyor (Test Modu Aktif)';

// Üç Katmanlı Akıllı Kamera Kuyruğu:
// 1. giftFocusQueue (Hediyeler)
// 2. flameFocusQueue (Alev alanları sırayla ekrana getiren özel vitrin kuyruğu)
// 3. freeFocusQueue (Katılma, çalışma, ayrılma)
let activeFocus = null;
let giftFocusQueue = [];
let flameFocusQueue = [];
let freeFocusQueue = [];

const likeRateLimiter = new Map();
const likeCamCooldown = new Map();
const alreadySeatedCamCooldown = new Map();
const reminderCooldown = new Map();
const seenChatIds = new Set();

const knownRealUsers = new Map();
const seenInRoomUsers = new Set();
const missingRoomUserStrikes = new Map();
let lastKnownViewerCount = 0;

let gameState = {
    round: 1,
    phase: 'playing', // 'playing' | 'podium'
    timeLeft: ROUND_DURATION,
    panicMode: false,
    hypeMeter: 0,      // 0..100 Kolektif Sınıf Kaos Barı
    goldenStormUntil: 0, // Dolduğunda 20 sn 3x Puan Fırtınası
    seatLayout: SEAT_LAYOUT,
    seats: Array(MAX_SEATS).fill(null),
    exitingStudents: [],
    proctors: [],
    proctorRecord: 0,
    podiumWinners: [],
    dailyRecord: { nickname: 'Henüz Yok', score: 0 },
    cheatChain: { count: 0, lastAt: 0, seatIndices: [] },
    rivalries: [],
    fxEvents: [],
    activeFocus: null,
    banner: null,
    cheatPasses: [],
    worldEffect: null
};

function normalizeTr(str) {
    return String(str || '').trim().toLocaleLowerCase('tr-TR');
}

function getAllOccupiedNamesSet() {
    const used = new Set();
    for (const s of gameState.seats) {
        if (s && s.nickname) used.add(normalizeTr(s.nickname));
    }
    for (const p of gameState.proctors) {
        if (p && p.nickname) used.add(normalizeTr(p.nickname));
    }
    for (const ex of gameState.exitingStudents) {
        if (ex && ex.nickname) used.add(normalizeTr(ex.nickname));
    }
    for (const realNick of knownRealUsers.values()) {
        if (realNick) used.add(normalizeTr(realNick));
    }
    return used;
}

function pickUniqueBotName() {
    const used = getAllOccupiedNamesSet();
    const available = TURKISH_BOT_NAMES.filter(name => !used.has(normalizeTr(name)));
    if (available.length > 0) {
        return available[Math.floor(Math.random() * available.length)];
    }

    for (let attempt = 0; attempt < 300; attempt++) {
        const fn = TURKISH_BOT_NAMES[Math.floor(Math.random() * 180)];
        const sn = TURKISH_SURNAMES[Math.floor(Math.random() * TURKISH_SURNAMES.length)];
        const combo = `${fn} ${sn}`;
        if (!used.has(normalizeTr(combo))) return combo;
    }
    return `Öğrenci_${Math.floor(1000 + Math.random() * 9000)}`;
}

function getScoreMultiplier() {
    const now = Date.now();
    let mult = 1;
    if (gameState.panicMode) mult *= 2;
    if (now < (gameState.goldenStormUntil || 0)) mult *= 3;
    return mult;
}

function addHype(amount) {
    const now = Date.now();
    if (now < (gameState.goldenStormUntil || 0)) return;
    gameState.hypeMeter = Math.min(100, (gameState.hypeMeter || 0) + amount);
    if (gameState.hypeMeter >= 100) {
        gameState.hypeMeter = 0;
        gameState.goldenStormUntil = now + 20000;
        emitFx('golden_storm', { text: '⚡ ALTIN SINAV FIRTINASI (3x PUAN)!', color: '#facc15' });
        triggerBanner('⚡ ALTIN SINAV FIRTINASI BAŞLADI!', '20 saniye boyunca tüm beğeniler ve kopyalar 3x PUAN!', '#facc15');
    }
}

function emitFx(type, payload = {}) {
    const now = Date.now();
    gameState.fxEvents.push({
        id: now + Math.random(),
        type,
        createdAt: now,
        ...payload
    });
    if (gameState.fxEvents.length > 60) {
        gameState.fxEvents.shift();
    }
}

function calculateProctorRadius(coins, isPanic = false) {
    const c = Math.max(0, Number(coins) || 0);
    const base = 7.2 + Math.sqrt(c) * 0.65;
    const finalRad = isPanic ? base * 1.3 : base;
    return Number(Math.min(18.0, finalRad).toFixed(2));
}

// Alev Seviyeleri: İlk beğenide (15+ puan) hemen Seviye 1 Alev başlar!
function getFlameLevel(score) {
    if (score >= 400) return 5; // Beyaz-Altın Süpernova Alevi
    if (score >= 200) return 4; // Mor Kozmik Alev
    if (score >= 100) return 3; // Mavi Plazma Alevi
    if (score >= 45) return 2;  // Kızıl-Turuncu Güçlü Alev
    if (score >= 15) return 1;  // Turuncu-Sarı Başlangıç Alevi
    return 0;
}

function getPenaltyLevel(score) {
    if (score <= 0) return 2;  // Sıfır Puan (Kaldı / Kara Duman)
    if (score < 10) return 1;  // Tehlike Bölgesi (Stres Bulutu)
    return 0;
}

function syncStudentVisualTiers(student) {
    if (!student) return;
    student.flameLevel = getFlameLevel(student.score);
    student.penaltyLevel = getPenaltyLevel(student.score);

    const milestone = Math.floor(student.score / 300);
    if (milestone > (student.lastShieldMilestone || 0) && !student.shield) {
        student.lastShieldMilestone = milestone;
        student.shield = true;
        emitFx('shield_gain', { seatIndex: student.seatIndex, text: '🛡️ KALKAN KAZANDI!', color: '#38bdf8' });
    }

    if (student.score > (gameState.dailyRecord.score || 0)) {
        gameState.dailyRecord = {
            nickname: student.nickname,
            score: student.score
        };
    }
}

function updateLeaderCrown() {
    let topStudent = null;
    for (const s of gameState.seats) {
        if (!s) continue;
        s.isLeader = false;
        if (!topStudent || s.score > topStudent.score) {
            topStudent = s;
        }
    }
    if (topStudent && topStudent.score > 10) {
        topStudent.isLeader = true;
    }
}

function addOrRefreshRivalry(hunter, target) {
    if (!hunter || !target || hunter.userId === target.userId) return;
    const now = Date.now();
    gameState.rivalries = gameState.rivalries.filter(r =>
        !(r.hunterId === hunter.userId && r.targetId === target.userId) && r.expiresAt > now
    );
    gameState.rivalries.push({
        id: now + Math.random(),
        hunterId: hunter.userId,
        targetId: target.userId,
        hunterSeat: hunter.seatIndex,
        targetSeat: target.seatIndex,
        expiresAt: now + 45000
    });
}

function checkAndConsumeRevenge(attacker, defender) {
    const now = Date.now();
    const revIdx = gameState.rivalries.findIndex(r =>
        r.hunterId === defender.userId && r.targetId === attacker.userId && r.expiresAt > now
    );
    if (revIdx !== -1) {
        gameState.rivalries.splice(revIdx, 1);
        return true;
    }
    return false;
}

function tryConsumeStudentShield(student, reasonLabel) {
    if (!student || !student.shield) return false;
    const now = Date.now();
    student.shield = false;
    student.lastPopup = { text: `🛡️ KALKAN KORUDU!`, color: '#38bdf8', id: now + Math.random() };
    emitFx('shield_break', {
        seatIndex: student.seatIndex,
        text: `🛡️ KALKAN KORUDU!`,
        color: '#38bdf8'
    });
    triggerBanner('🛡️ İNEK ÖĞRENCİ KALKANI!', `${student.nickname} (${reasonLabel}) kalkanıyla cezadan kurtuldu!`, '#38bdf8');
    return true;
}

function pickValidId(...candidates) {
    for (const c of candidates) {
        if (c === undefined || c === null) continue;
        const s = typeof c === 'bigint' ? c.toString() : String(c).trim();
        if (s && s !== '0' && s !== 'undefined' && s !== 'null' && s !== '[object Object]') {
            return s;
        }
    }
    return '';
}

function extractTikTokUser(data) {
    const u = (data && data.user) ? data.user : (data || {});
    const picFromArray = u.profilePicture && Array.isArray(u.profilePicture.url) ? u.profilePicture.url[0] : '';
    const nickname = pickValidId(u.nickname, data.nickname, u.uniqueId, u.displayId, data.uniqueId) || 'İzleyici';
    const userId = pickValidId(
        u.userId,
        u.id,
        u.secUid,
        u.uniqueId,
        u.displayId,
        data.userId,
        data.secUid,
        data.uniqueId,
        nickname !== 'İzleyici' ? `nick_${nickname}` : ''
    ) || `anon_${Date.now()}_${Math.random()}`;

    if (nickname !== 'İzleyici') {
        knownRealUsers.set(userId, nickname);
    }

    return {
        userId,
        nickname,
        avatar: picFromArray || u.profilePictureUrl || data.profilePictureUrl || ''
    };
}

function getRandomAvatarColor(name) {
    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

function findStudentByUserId(userId) {
    return gameState.seats.findIndex(s => s && s.userId === userId);
}

function touchUserActivity(userId) {
    missingRoomUserStrikes.delete(userId);
    const idx = findStudentByUserId(userId);
    if (idx !== -1 && gameState.seats[idx]) {
        gameState.seats[idx].lastActiveAt = Date.now();
    }
    const proctor = gameState.proctors.find(p => p.userId === userId);
    if (proctor) {
        proctor.lastActiveAt = Date.now();
    }
}

function scheduleCameraFocus(options) {
    const now = Date.now();
    const {
        isGift = false,
        coins = 0,
        priority = 1,
        type,
        userId,
        seatIndex = -1,
        targetSeatIndex = -1,
        proctorUserId = null,
        title,
        subtitle,
        color = '#fbbf24',
        baseDurationMs = 2800
    } = options;

    const item = {
        id: now + Math.random(),
        isGift,
        coins,
        priority,
        type,
        userId,
        seatIndex,
        targetSeatIndex,
        proctorUserId,
        title,
        subtitle,
        color,
        baseDurationMs,
        createdAt: now
    };

    // 1. Hediyeler Kuyruğu
    if (isGift) {
        giftFocusQueue.push(item);
        giftFocusQueue.sort((a, b) => b.coins - a.coins || a.createdAt - b.createdAt);

        if (!activeFocus || !activeFocus.isGift) {
            const nextGift = giftFocusQueue.shift();
            const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
            activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
            gameState.activeFocus = activeFocus;
            return;
        }

        if (activeFocus.isGift && coins > activeFocus.coins && (now - activeFocus.startedAt) >= 1100) {
            const nextGift = giftFocusQueue.shift();
            const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
            activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
            gameState.activeFocus = activeFocus;
        }
        return;
    }

    // 2. Özel Alev Vitrin Kuyruğu (Alev alan her öğrenci sırayla ekrana gelir!)
    if (type === 'flame') {
        if ((activeFocus && activeFocus.userId === userId && activeFocus.type === 'flame') ||
            flameFocusQueue.some(q => q.userId === userId)) {
            return;
        }
        if (flameFocusQueue.length < 10) {
            flameFocusQueue.push(item);
        }
        if (!activeFocus) {
            const nextFlame = flameFocusQueue.shift();
            activeFocus = { ...nextFlame, startedAt: now, expiresAt: now + nextFlame.baseDurationMs };
            gameState.activeFocus = activeFocus;
        }
        return;
    }

    // 3. Genel Etkileşim Kuyruğu
    if (giftFocusQueue.length > 0 || flameFocusQueue.length > 0 || (activeFocus && (activeFocus.isGift || activeFocus.type === 'flame'))) {
        return;
    }
    if (freeFocusQueue.some(q => q.userId === userId && q.type === type) || (activeFocus && activeFocus.userId === userId && activeFocus.type === type)) {
        return;
    }
    if (freeFocusQueue.length >= 4) return;

    freeFocusQueue.push(item);
    freeFocusQueue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    if (!activeFocus) {
        const nextFree = freeFocusQueue.shift();
        activeFocus = { ...nextFree, startedAt: now, expiresAt: now + nextFree.baseDurationMs };
        gameState.activeFocus = activeFocus;
    }
}

function getAdaptiveGiftDuration(waitingCount, baseMs) {
    if (waitingCount >= 7) return 1500;
    if (waitingCount >= 3) return 2100;
    return baseMs;
}

function processFocusQueues() {
    const now = Date.now();
    if (activeFocus && now < activeFocus.expiresAt) return;

    if (giftFocusQueue.length > 0) {
        const nextGift = giftFocusQueue.shift();
        const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
        activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
        gameState.activeFocus = activeFocus;
        return;
    }

    flameFocusQueue = flameFocusQueue.filter(q => now - q.createdAt < 25000);
    if (flameFocusQueue.length > 0) {
        const nextFlame = flameFocusQueue.shift();
        const dur = flameFocusQueue.length >= 4 ? 1700 : nextFlame.baseDurationMs;
        activeFocus = { ...nextFlame, startedAt: now, expiresAt: now + dur };
        gameState.activeFocus = activeFocus;
        return;
    }

    freeFocusQueue = freeFocusQueue.filter(q => now - q.createdAt < 10000);
    if (freeFocusQueue.length > 0) {
        const nextFree = freeFocusQueue.shift();
        activeFocus = { ...nextFree, startedAt: now, expiresAt: now + nextFree.baseDurationMs };
        gameState.activeFocus = activeFocus;
        return;
    }

    activeFocus = null;
    gameState.activeFocus = null;
}

function triggerBanner(title, subtitle, color = '#f59e0b') {
    gameState.banner = {
        id: Date.now() + Math.random(),
        title,
        subtitle,
        color
    };
}

function findNearestNeighborSeat(actorSeatIdx) {
    const posA = SEAT_LAYOUT[actorSeatIdx];
    let nearestStudent = null;
    let minDist = Infinity;

    for (let i = 0; i < MAX_SEATS; i++) {
        if (i === actorSeatIdx || !gameState.seats[i]) continue;
        const posB = SEAT_LAYOUT[i];
        const dist = Math.hypot(posA.x - posB.x, posA.y - posB.y, posA.z - posB.z);
        if (dist < minDist) {
            minDist = dist;
            nearestStudent = gameState.seats[i];
        }
    }

    return nearestStudent;
}

function triggerProctorStrike(proctor, student, penalty, coins, actorUser, otherSeatIdx = -1) {
    const now = Date.now();
    const sIdx = student.seatIndex;
    const pos = SEAT_LAYOUT[sIdx];

    proctor.x = pos.x + (pos.x >= 0 ? -1.05 : 1.05);
    proctor.z = pos.z + 0.75;
    proctor.y = pos.y;
    proctor.targetX = proctor.x;
    proctor.targetZ = proctor.z;
    proctor.attackingUntil = now + 1600;
    proctor.attackTargetSeat = sIdx;

    if (tryConsumeStudentShield(student, 'Gözetmen Baskını')) {
        student.cheatingUntil = 0;
        proctor.lastPopup = { text: `🛡️ KALKANA ÇARPTI!`, color: '#38bdf8', id: now + Math.random() };
        return;
    }

    student.score = Math.max(0, student.score - penalty);
    student.cheatingUntil = 0;
    student.caughtUntil = now + 2600;
    student.penaltyUntil = now + 4500;
    student.statusEffect = 'caught';
    student.statusUntil = now + 4500;
    student.lastPopup = { text: `💥 -${penalty} YAKALANDI!`, color: '#ef4444', id: now + Math.random() };
    syncStudentVisualTiers(student);

    proctor.catches += 1;
    const proctorGain = gameState.panicMode ? 70 : 35;
    proctor.score = (proctor.score || 0) + proctorGain;
    proctor.lastPopup = { text: `+${proctorGain} Gözetmen Puanı!`, color: '#fbbf24', id: now + Math.random() };

    emitFx('whack', {
        seatIndex: sIdx,
        text: `💥 -${penalty} CETVEL!`,
        color: '#ef4444'
    });

    updateLeaderCrown();

    scheduleCameraFocus({
        isGift: coins > 0,
        coins,
        priority: 4,
        type: 'caught',
        userId: actorUser ? actorUser.userId : student.userId,
        seatIndex: sIdx,
        targetSeatIndex: otherSeatIdx,
        proctorUserId: proctor.userId,
        title: `🚨 GÖZETMEN ${proctor.nickname} CETVELLE YAKALADI!`,
        subtitle: `${student.nickname} (-${penalty} Puan) • ${proctor.nickname} +${proctorGain} Puan!`,
        color: '#ef4444',
        baseDurationMs: 3000
    });
}

function checkProctorProximityPenalty(giverSeatIdx, receiverSeatIdx, actorUser, coins, isSabotage = false) {
    if (gameState.proctors.length === 0) return false;
    const targets = [giverSeatIdx, receiverSeatIdx].filter(i => i >= 0 && gameState.seats[i]);

    let anyoneCaught = false;
    for (const proctor of gameState.proctors) {
        const radius = proctor.patrolRadius || calculateProctorRadius(proctor.coins, gameState.panicMode);
        for (const sIdx of targets) {
            const student = gameState.seats[sIdx];
            if (!student) continue;
            const pos = SEAT_LAYOUT[sIdx];
            const dist = Math.hypot(proctor.x - pos.x, (proctor.y - pos.y) * 1.35, proctor.z - pos.z);

            if (dist <= radius) {
                const penalty = isSabotage ? 35 : 45;
                const otherIdx = giverSeatIdx === sIdx ? receiverSeatIdx : giverSeatIdx;
                triggerProctorStrike(proctor, student, penalty, coins, actorUser, otherIdx);
                anyoneCaught = true;
                break;
            }
        }
    }
    return anyoneCaught;
}

// Ön sıralardan başlayarak en uygun boş koltuğu seçer
function pickFrontPriorityEmptySeat() {
    const emptyIndices = [];
    for (let i = 0; i < MAX_SEATS; i++) {
        if (!gameState.seats[i]) emptyIndices.push(i);
    }
    if (emptyIndices.length === 0) return -1;
    // En öndeki 20 boş koltuk arasından rastgele seçerek önden arkaya doğru doğal dolum sağlar
    const frontPool = emptyIndices.slice(0, Math.min(20, emptyIndices.length));
    return frontPool[Math.floor(Math.random() * frontPool.length)];
}

function seatStudent(user, skipCamera = false, notifyIfAlreadySeated = false) {
    const existingIdx = findStudentByUserId(user.userId);
    if (existingIdx !== -1) {
        touchUserActivity(user.userId);
        if (notifyIfAlreadySeated && !skipCamera) {
            const now = Date.now();
            const lastNotify = alreadySeatedCamCooldown.get(user.userId) || 0;
            if (now - lastNotify > 8000) {
                alreadySeatedCamCooldown.set(user.userId, now);
                scheduleCameraFocus({
                    isGift: false,
                    coins: 0,
                    priority: 2,
                    type: 'already_seated',
                    userId: user.userId,
                    seatIndex: existingIdx,
                    title: `👋 ${user.nickname} Zaten Sınıfta!`,
                    subtitle: `Amfi Sıra #${existingIdx + 1} koltuğunda (${gameState.seats[existingIdx].score} Puan)`,
                    color: '#38bdf8',
                    baseDurationMs: 2500
                });
            }
        }
        return existingIdx;
    }
    if (gameState.proctors.some(p => p.userId === user.userId)) {
        touchUserActivity(user.userId);
        return -1;
    }

    const chosenSeat = pickFrontPriorityEmptySeat();
    if (chosenSeat === -1) return -1;

    const now = Date.now();
    const newStudent = {
        seatIndex: chosenSeat,
        userId: user.userId,
        nickname: user.nickname || pickUniqueBotName(),
        avatar: user.avatar || '',
        color: getRandomAvatarColor(user.userId),
        score: 10,
        flameLevel: 0,
        penaltyLevel: 0,
        shield: false,
        lastShieldMilestone: 0,
        isLeader: false,
        comboCount: 0,
        lastLikeAt: 0,
        joinedAt: now,
        lastActiveAt: now,
        studyingUntil: 0,
        cheatingUntil: 0,
        cheatTargetSeat: -1,
        caughtUntil: 0,
        penaltyUntil: 0,
        statusEffect: null,
        statusUntil: 0,
        lastPopup: { text: '+10 Sınıfa Girdi', color: '#34d399', id: now }
    };
    syncStudentVisualTiers(newStudent);
    gameState.seats[chosenSeat] = newStudent;
    updateLeaderCrown();
    addHype(2);

    emitFx('join', { seatIndex: chosenSeat, text: '+10 GİRDİ!', color: '#34d399' });

    if (!skipCamera) {
        scheduleCameraFocus({
            isGift: false,
            coins: 0,
            priority: 2,
            type: 'join',
            userId: user.userId,
            seatIndex: chosenSeat,
            title: `🚪 ${newStudent.nickname} Sınıfa Girdi!`,
            subtitle: `Amfi Sıra #${chosenSeat + 1} koltuğuna oturdu!`,
            color: '#34d399',
            baseDurationMs: 2800
        });
    }
    return chosenSeat;
}

function removeStudentFromHall(seatIdx, reasonText = 'Yayından ayrıldı') {
    const student = gameState.seats[seatIdx];
    if (!student) return;

    const now = Date.now();
    gameState.seats[seatIdx] = null;
    seenInRoomUsers.delete(student.userId);
    missingRoomUserStrikes.delete(student.userId);
    gameState.rivalries = gameState.rivalries.filter(r => r.hunterId !== student.userId && r.targetId !== student.userId);
    updateLeaderCrown();

    gameState.exitingStudents.push({
        id: now + Math.random(),
        userId: student.userId,
        nickname: student.nickname,
        avatar: student.avatar,
        color: student.color,
        score: student.score,
        fromSeatIndex: seatIdx,
        startedAt: now,
        durationMs: 3800
    });

    scheduleCameraFocus({
        isGift: false,
        coins: 0,
        priority: 2,
        type: 'leave',
        userId: student.userId,
        seatIndex: seatIdx,
        title: `👋 ${student.nickname} Sınıftan Ayrıldı`,
        subtitle: `${reasonText} • Çıkış kapısına yürüyor...`,
        color: '#94a3b8',
        baseDurationMs: 2800
    });
}

function removeUserCompletely(userId, reasonText = 'Yayından ayrıldı') {
    const seatIdx = findStudentByUserId(userId);
    if (seatIdx !== -1) {
        removeStudentFromHall(seatIdx, reasonText);
    }
    const pIdx = gameState.proctors.findIndex(p => p.userId === userId);
    if (pIdx !== -1) {
        const p = gameState.proctors[pIdx];
        gameState.proctors.splice(pIdx, 1);
        if (gameState.proctors.length === 0) gameState.proctorRecord = 0;
        triggerBanner('GÖZETMEN AYRILDI', `${p.nickname} (${reasonText})`, '#94a3b8');
    }
}

function promoteToProctor(user, coins) {
    const seatIdx = findStudentByUserId(user.userId);
    const carriedScore = seatIdx !== -1 && gameState.seats[seatIdx] ? gameState.seats[seatIdx].score : 20;
    if (seatIdx !== -1) gameState.seats[seatIdx] = null;
    updateLeaderCrown();

    const existingProctor = gameState.proctors.find(p => p.userId === user.userId);
    if (existingProctor) {
        existingProctor.coins = Math.max(existingProctor.coins, coins);
        existingProctor.patrolRadius = calculateProctorRadius(existingProctor.coins, gameState.panicMode);
        existingProctor.lastActiveAt = Date.now();
    } else {
        // Gözetmen ön sıraların (Tier 0-1) tam önündeki koridorda başlar
        const startAngle = (Math.random() - 0.5) * 0.85;
        const startRadius = 12.6 + Math.random() * 2.5;
        const newProctor = {
            userId: user.userId,
            nickname: user.nickname || pickUniqueBotName(),
            avatar: user.avatar || '',
            color: getRandomAvatarColor(user.userId),
            coins,
            score: carriedScore,
            patrolRadius: calculateProctorRadius(coins, gameState.panicMode),
            lastActiveAt: Date.now(),
            x: Math.sin(startAngle) * startRadius,
            y: 0.45,
            z: Math.cos(startAngle) * startRadius - 10,
            targetX: 0,
            targetZ: 3.5,
            patrolAngle: startAngle,
            patrolDir: 1,
            catches: 0,
            attackingUntil: 0,
            attackTargetSeat: -1,
            lastPopup: null
        };

        if (coins > gameState.proctorRecord) {
            const retiredNames = gameState.proctors.map(p => p.nickname).join(', ');
            gameState.proctors = [newProctor];
            gameState.proctorRecord = coins;
            const extraMsg = retiredNames ? ` (${retiredNames} emekli oldu!)` : '';
            triggerBanner('YENİ GÖZETMEN ATANDI!', `${newProctor.nickname} (${coins} Jeton • Alan: ${newProctor.patrolRadius}m)${extraMsg}`, '#f59e0b');
        } else if (coins === gameState.proctorRecord && coins > 0) {
            gameState.proctors.push(newProctor);
            triggerBanner('GÖZETMEN SAYISI ARTTI!', `${newProctor.nickname} eşit jetonla (${coins}) devriyeye katıldı!`, '#fbbf24');
        } else if (coins === 0 && gameState.proctors.length === 0) {
            gameState.proctors = [newProctor];
            gameState.proctorRecord = 0;
            triggerBanner('TUR BİRİNCİSİ BAŞGÖZETMEN!', `${newProctor.nickname} Başgözetmen oldu • Diğerleri en ön sırada!`, '#38bdf8');
        }
    }

    if (coins > 0) {
        const pObj = gameState.proctors.find(p => p.userId === user.userId);
        const rad = pObj ? pObj.patrolRadius : calculateProctorRadius(coins, gameState.panicMode);
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'proctor',
            userId: user.userId,
            proctorUserId: user.userId,
            title: `👮 GÖZETMEN ${user.nickname} (${coins} Jeton)`,
            subtitle: `Ön Sıralar Devriyesi Başladı • Alan: ${rad}m!`,
            color: '#f59e0b',
            baseDurationMs: 3200
        });
    }
}

function handleLike(user, count = 1) {
    if (gameState.phase !== 'playing') return;
    const now = Date.now();
    const rl = likeRateLimiter.get(user.userId) || { windowStart: now, gained: 0 };
    if (now - rl.windowStart > 3000) {
        rl.windowStart = now;
        rl.gained = 0;
    }

    const idx = findStudentByUserId(user.userId);
    if (idx === -1) {
        if (gameState.proctors.some(p => p.userId === user.userId)) {
            touchUserActivity(user.userId);
        }
        return;
    }

    const student = gameState.seats[idx];
    student.lastActiveAt = now;

    if (rl.gained >= 15) return;
    const allowedGain = Math.min(count, 15 - rl.gained);
    rl.gained += allowedGain;
    likeRateLimiter.set(user.userId, rl);

    if (now - (student.lastLikeAt || 0) < 4500) {
        student.comboCount = Math.min(5, (student.comboCount || 1) + 1);
    } else {
        student.comboCount = 1;
    }
    student.lastLikeAt = now;

    const mult = getScoreMultiplier();
    const comboBonus = student.comboCount >= 2 ? Math.ceil(allowedGain * 0.5) : 0;
    const totalGain = (allowedGain + comboBonus) * mult;

    const prevFlame = student.flameLevel || 0;
    student.score += totalGain;
    student.studyingUntil = now + 3500;
    syncStudentVisualTiers(student);
    updateLeaderCrown();
    addHype(Math.max(1, Math.ceil(allowedGain / 3)));

    const flameNames = ['', '🔥 ALEV ALDI!', '🔥🔥 KIZIL ALEV!', '💙 MAVİ PLAZMA!', '💜 MOR KOZMİK!', '👑 SÜPERNOVA!'];
    let popupText = `+${totalGain} Çalıştı`;
    if (student.flameLevel > prevFlame) {
        popupText = `+${totalGain} ${flameNames[student.flameLevel]}`;
        emitFx('flame_up', { seatIndex: idx, text: flameNames[student.flameLevel], color: '#f97316', level: student.flameLevel });
    } else if (student.comboCount >= 2) {
        popupText = `+${totalGain} (⚡x${student.comboCount} KOMBO!)`;
        emitFx('combo', { seatIndex: idx, combo: student.comboCount, text: `+${totalGain} x${student.comboCount}`, color: '#4ade80' });
    } else {
        emitFx('like', { seatIndex: idx, text: `+${totalGain}`, color: '#4ade80' });
    }

    student.lastPopup = { text: popupText, color: '#4ade80', id: now + Math.random() };

    const gotFlaming = student.flameLevel > prevFlame;
    const lastCam = likeCamCooldown.get(user.userId) || 0;

    if (gotFlaming) {
        // Alev alan her öğrenci özel sıraya alınır ve ekranda sırayla gösterilir!
        scheduleCameraFocus({
            isGift: false,
            coins: 0,
            priority: 3,
            type: 'flame',
            userId: user.userId,
            seatIndex: idx,
            title: `${flameNames[student.flameLevel]} ${student.nickname}!`,
            subtitle: `Sıra #${idx + 1} • Puan: ${student.score} (Seviye ${student.flameLevel})`,
            color: '#f97316',
            baseDurationMs: 2500
        });
    } else if (now - lastCam > 14000) {
        likeCamCooldown.set(user.userId, now);
        scheduleCameraFocus({
            isGift: false,
            coins: 0,
            priority: 1,
            type: 'study',
            userId: user.userId,
            seatIndex: idx,
            title: `📚 ${student.nickname} Ders Çalışıyor!`,
            subtitle: `Kombo x${student.comboCount} (+${totalGain} Puan • Toplam: ${student.score})`,
            color: '#4ade80',
            baseDurationMs: 2200
        });
    }
}

function handleGift(user, coins) {
    if (gameState.phase !== 'playing') return;
    const now = Date.now();
    touchUserActivity(user.userId);
    addHype(Math.min(45, coins * 2));

    // 100+ Jeton: Başgözetmen + Kader Değiştirici
    // veya 15+ Jeton: Rekor Gözetmenlik
    if (coins >= 100 || (coins > gameState.proctorRecord && coins >= 15) || (coins === gameState.proctorRecord && coins >= 15)) {
        promoteToProctor(user, coins);

        if (coins >= 100) {
            const isAmnesty = Math.random() > 0.5;
            gameState.worldEffect = {
                id: now + Math.random(),
                type: isAmnesty ? 'amnesty' : 'discipline',
                expiresAt: now + 4800
            };
            emitFx('thunder', { text: isAmnesty ? '🌟 GENEL AF (+75)!' : '⚡ SIKI YÖNETİM (-80)!', color: isAmnesty ? '#10b981' : '#ef4444' });

            gameState.seats.forEach(s => {
                if (!s) return;
                if (isAmnesty) {
                    s.score += 75;
                    s.statusEffect = 'cheer';
                    s.statusUntil = now + 4500;
                    s.lastPopup = { text: '+75 GENEL AF!', color: '#34d399', id: now + Math.random() };
                } else if (s.cheatingUntil > now) {
                    if (!tryConsumeStudentShield(s, 'Sıkı Yönetim')) {
                        s.score = Math.max(0, s.score - 80);
                        s.cheatingUntil = 0;
                        s.caughtUntil = now + 2600;
                        s.penaltyUntil = now + 4800;
                        s.statusEffect = 'caught';
                        s.statusUntil = now + 4500;
                        s.lastPopup = { text: '-80 DİSİPLİN!', color: '#f87171', id: now + Math.random() };
                    }
                }
                syncStudentVisualTiers(s);
            });
            updateLeaderCrown();
            triggerBanner(
                isAmnesty ? '🌟 KADER DEĞİŞTİ: GENEL AF (+75)!' : '⚡ KADER DEĞİŞTİ: SIKI YÖNETİM!',
                `${user.nickname} (${coins} Jeton) tüm amfinin kaderini değiştirdi!`,
                isAmnesty ? '#10b981' : '#ef4444'
            );
        }
        return;
    }

    // Aktif gözetmen hediye atarsa alanı ve puanı büyür
    const activeProctor = gameState.proctors.find(p => p.userId === user.userId);
    if (activeProctor) {
        activeProctor.coins += coins;
        activeProctor.score = (activeProctor.score || 0) + coins * 3;
        activeProctor.patrolRadius = calculateProctorRadius(activeProctor.coins, gameState.panicMode);
        activeProctor.lastPopup = { text: `Alan: ${activeProctor.patrolRadius}m (+${coins * 3} Puan)`, color: '#fbbf24', id: now };
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'proctor',
            userId: user.userId,
            proctorUserId: user.userId,
            title: `👮 Gözetmen ${user.nickname} (+${coins} Jeton)`,
            subtitle: `Gözetleme Alanı ${activeProctor.patrolRadius}m oldu! (Puan: ${activeProctor.score})`,
            color: '#fbbf24',
            baseDurationMs: 2600
        });
        return;
    }

    // Sınıfa girmek için önce "katıl" yazmak şarttır
    const idx = findStudentByUserId(user.userId);
    if (idx === -1) {
        const lastRem = reminderCooldown.get(user.userId) || 0;
        if (now - lastRem > 10000) {
            reminderCooldown.set(user.userId, now);
            triggerBanner('ÖNCE SINIFA KATIL!', `${user.nickname}, sıraya oturmak için sohbete "katıl" yaz!`, '#38bdf8');
        }
        return;
    }

    const actor = gameState.seats[idx];
    actor.lastActiveAt = now;
    const occupied = gameState.seats.filter(s => s && s.userId !== user.userId);
    const mult = getScoreMultiplier();

    // 50+ Jeton: Cevap Anahtarı + Yıldırım Saldırısı (+150 Puan + 5 Rakibe -35)
    if (coins >= 50) {
        const gain = 150 * mult;
        actor.score += gain;
        actor.statusEffect = 'answer_key';
        actor.statusUntil = now + 4800;
        actor.lastPopup = { text: `🔑 +${gain} CEVAP ANAHTARI!`, color: '#fbbf24', id: now };
        syncStudentVisualTiers(actor);
        emitFx('thunder', { seatIndex: idx, text: `🔑 +${gain} CEVAP ANAHTARI!`, color: '#fbbf24' });

        const victims = occupied.sort(() => 0.5 - Math.random()).slice(0, 5);
        victims.forEach(v => {
            if (!tryConsumeStudentShield(v, 'Cevap Anahtarı Saldırısı')) {
                v.score = Math.max(0, v.score - 35);
                v.caughtUntil = now + 2400;
                v.penaltyUntil = now + 4500;
                v.statusEffect = 'burned';
                v.statusUntil = now + 4500;
                v.lastPopup = { text: '🔥 -35 Kağıt Yandı!', color: '#f87171', id: now + Math.random() };
                syncStudentVisualTiers(v);
                emitFx('whack', { seatIndex: v.seatIndex, text: '-35 YANDI!', color: '#f87171' });
            }
        });
        updateLeaderCrown();
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'answer_key',
            userId: user.userId,
            seatIndex: idx,
            title: `🔑 ${actor.nickname} (${coins} Jeton)`,
            subtitle: `Cevap anahtarını kaptı (+${gain}) ve 5 rakibi yaktı!`,
            color: '#fbbf24',
            baseDurationMs: 3200
        });
        return;
    }

    // 30+ Jeton: Süper Alev + Koruma Kalkanı (+80 Puan + Anında Kızıl/Mavi Alev + Kalkan)
    if (coins >= 30) {
        const gain = 80 * mult;
        actor.score += gain;
        actor.studyingUntil = now + 5000;
        actor.shield = true;
        syncStudentVisualTiers(actor);
        if (actor.flameLevel < 2) actor.flameLevel = 2;
        actor.lastPopup = { text: `🔥🛡️ +${gain} SÜPER ALEV!`, color: '#f97316', id: now };
        emitFx('flame_up', { seatIndex: idx, text: `🔥🛡️ +${gain} SÜPER ALEV!`, color: '#f97316', level: actor.flameLevel });
        emitFx('shield_gain', { seatIndex: idx, text: '🛡️ KALKAN AKTİF!', color: '#38bdf8' });
        updateLeaderCrown();

        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'flame',
            userId: user.userId,
            seatIndex: idx,
            title: `🔥🛡️ ${actor.nickname} SÜPER ALEV ALDI!`,
            subtitle: `+${gain} Puan + Koruma Kalkanı kazandı!`,
            color: '#f97316',
            baseDurationMs: 3000
        });
        return;
    }

    // 10+ Jeton: İspiyonla (İntikam varsa 2x!)
    if (coins >= 10) {
        const cheaters = occupied.filter(s => s.cheatingUntil > now);
        const target = cheaters.length > 0
            ? cheaters[Math.floor(Math.random() * cheaters.length)]
            : occupied.sort((a, b) => b.score - a.score)[0];

        const isRevenge = target ? checkAndConsumeRevenge(actor, target) : false;
        const reward = (isRevenge ? 70 : 35) * mult;

        actor.score += reward;
        actor.statusEffect = 'snitch';
        actor.statusUntil = now + 3800;
        actor.lastPopup = { text: isRevenge ? `⚔️ +${reward} İNTİKAM!` : `📣 +${reward} İspiyon!`, color: '#38bdf8', id: now };
        syncStudentVisualTiers(actor);

        if (target) {
            addOrRefreshRivalry(actor, target);
            const penalty = (cheaters.length > 0 ? 55 : 35) * (isRevenge ? 2 : 1);

            if (gameState.proctors.length > 0) {
                triggerProctorStrike(gameState.proctors[0], target, penalty, coins, user, idx);
            } else if (!tryConsumeStudentShield(target, 'İspiyon')) {
                target.score = Math.max(0, target.score - penalty);
                target.cheatingUntil = 0;
                target.caughtUntil = now + 2500;
                target.penaltyUntil = now + 4500;
                target.statusEffect = 'caught';
                target.statusUntil = now + 4500;
                target.lastPopup = { text: `🚨 -${penalty} İSPİYONLANDI!`, color: '#ef4444', id: now };
                syncStudentVisualTiers(target);
                emitFx('whack', { seatIndex: target.seatIndex, text: `-${penalty} İSPİYON!`, color: '#ef4444' });

                scheduleCameraFocus({
                    isGift: true,
                    coins,
                    priority: 3,
                    type: 'snitch',
                    userId: user.userId,
                    seatIndex: idx,
                    targetSeatIndex: target.seatIndex,
                    title: isRevenge ? `⚔️ ${actor.nickname} İNTİKAM ALDI!` : `📣 ${actor.nickname} İspiyonladı (${coins} Jeton)!`,
                    subtitle: `${target.nickname} yakalandı (-${penalty} Puan)!`,
                    color: '#38bdf8',
                    baseDurationMs: 2800
                });
            }
        } else {
            scheduleCameraFocus({
                isGift: true,
                coins,
                priority: 3,
                type: 'snitch',
                userId: user.userId,
                seatIndex: idx,
                title: `📣 ${actor.nickname} (${coins} Jeton)`,
                subtitle: `İspiyon ödülü kazandı (+${reward} Puan)!`,
                color: '#38bdf8',
                baseDurationMs: 2500
            });
        }
        updateLeaderCrown();
        return;
    }

    // 5+ Jeton: En Yakındaki Komşuya Yanlış Kopya Atma (İntikam varsa 2x!)
    if (coins >= 5) {
        const victim = findNearestNeighborSeat(idx);
        if (victim) {
            actor.cheatingUntil = now + 5000;
            actor.statusEffect = 'sabotage';
            actor.statusUntil = now + 4000;
            victim.cheatingUntil = now + 5000;

            gameState.cheatPasses.push({
                id: now + Math.random(),
                fromSeat: idx,
                toSeat: victim.seatIndex,
                isSabotage: true,
                createdAt: now
            });

            const caught = checkProctorProximityPenalty(idx, victim.seatIndex, user, coins, true);
            if (!caught) {
                addOrRefreshRivalry(actor, victim);
                const isRevenge = checkAndConsumeRevenge(actor, victim);
                const dmg = isRevenge ? 50 : 30;
                const gain = (isRevenge ? 40 : 20) * mult;

                if (!tryConsumeStudentShield(victim, 'Yanlış Kopya Sabotajı')) {
                    victim.score = Math.max(0, victim.score - dmg);
                    victim.caughtUntil = now + 2000;
                    victim.penaltyUntil = now + 4500;
                    victim.statusEffect = 'wrong_cheat';
                    victim.statusUntil = now + 4500;
                    victim.lastPopup = { text: `😈 -${dmg} Yanlış Kopya!`, color: '#fb7185', id: now };
                    syncStudentVisualTiers(victim);
                    emitFx('whack', { seatIndex: victim.seatIndex, text: `-${dmg} SABOTAJ!`, color: '#fb7185' });
                }

                actor.score += gain;
                actor.lastPopup = { text: isRevenge ? `⚔️ +${gain} İNTİKAM!` : `😈 +${gain} Sabotaj`, color: '#fb7185', id: now };
                syncStudentVisualTiers(actor);
                updateLeaderCrown();

                scheduleCameraFocus({
                    isGift: true,
                    coins,
                    priority: 2,
                    type: 'sabotage',
                    userId: user.userId,
                    seatIndex: idx,
                    targetSeatIndex: victim.seatIndex,
                    title: isRevenge ? `⚔️ ${actor.nickname} İNTİKAM SABOTAJI YAPTI!` : `😈 ${actor.nickname} Yanlış Kopya Attı!`,
                    subtitle: `Yanındaki ${victim.nickname} yanlış kopyayı aldı (-${dmg} Puan)!`,
                    color: '#fb7185',
                    baseDurationMs: 2600
                });
            }
        } else {
            const gain = 25 * mult;
            actor.score += gain;
            syncStudentVisualTiers(actor);
            updateLeaderCrown();
            scheduleCameraFocus({
                isGift: true,
                coins,
                priority: 2,
                type: 'sabotage',
                userId: user.userId,
                seatIndex: idx,
                title: `😈 ${actor.nickname} (${coins} Jeton)`,
                subtitle: `Bonus puan kazandı (+${gain} Puan)!`,
                color: '#fb7185',
                baseDurationMs: 2400
            });
        }
        return;
    }

    // 1-4 Jeton: En Yakındaki Komşudan Kopya Çekme + Kopya Zinciri Kombo!
    const neighbor = findNearestNeighborSeat(idx);
    actor.cheatingUntil = now + 6000;
    actor.cheatTargetSeat = neighbor ? neighbor.seatIndex : -1;

    if (now - (gameState.cheatChain.lastAt || 0) < 6500) {
        gameState.cheatChain.count = Math.min(6, (gameState.cheatChain.count || 1) + 1);
        if (!gameState.cheatChain.seatIndices.includes(idx)) {
            gameState.cheatChain.seatIndices.push(idx);
        }
    } else {
        gameState.cheatChain = { count: 1, lastAt: now, seatIndices: [idx] };
    }
    gameState.cheatChain.lastAt = now;

    if (neighbor) {
        neighbor.cheatingUntil = now + 6000;
        gameState.cheatPasses.push({
            id: now + Math.random(),
            fromSeat: neighbor.seatIndex,
            toSeat: idx,
            isSabotage: false,
            createdAt: now
        });
    }

    const caught = checkProctorProximityPenalty(neighbor ? neighbor.seatIndex : -1, idx, user, coins, false);
    if (!caught) {
        const chainMult = gameState.cheatChain.count >= 2 ? (1 + (gameState.cheatChain.count - 1) * 0.25) : 1;
        const gain = Math.round(25 * mult * chainMult);
        actor.score += gain;
        const chainTag = gameState.cheatChain.count >= 2 ? ` ⚡ZİNCİR x${gameState.cheatChain.count}!` : '';
        actor.lastPopup = { text: `👀 +${gain} Kopya${chainTag}`, color: '#facc15', id: now };
        syncStudentVisualTiers(actor);
        emitFx('combo', { seatIndex: idx, combo: gameState.cheatChain.count, text: `+${gain}${chainTag}`, color: '#facc15' });

        if (neighbor) {
            neighbor.score += 8 * mult;
            neighbor.lastPopup = { text: `+${8 * mult} Kopya Verdi!`, color: '#fde047', id: now + 0.1 };
            syncStudentVisualTiers(neighbor);
        }
        updateLeaderCrown();

        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 2,
            type: 'cheat',
            userId: user.userId,
            seatIndex: idx,
            targetSeatIndex: neighbor ? neighbor.seatIndex : -1,
            title: `👀 ${actor.nickname} Kopya Çekiyor${chainTag}`,
            subtitle: neighbor ? `Yanındaki ${neighbor.nickname} kağıdından çekti (+${gain})` : `Gizlice kopya çekti (+${gain})`,
            color: '#facc15',
            baseDurationMs: 2500
        });
    }
}

// 200ms Gözetmen Devriye Yakalama & Kamera Kuyruğu Döngüsü
setInterval(() => {
    const now = Date.now();
    processFocusQueues();

    if (gameState.phase !== 'playing') return;

    gameState.proctors.forEach(proctor => {
        const radius = proctor.patrolRadius || calculateProctorRadius(proctor.coins, gameState.panicMode);
        gameState.seats.forEach(s => {
            if (!s || s.cheatingUntil <= now) return;
            const pos = SEAT_LAYOUT[s.seatIndex];
            const dist = Math.hypot(proctor.x - pos.x, (proctor.y - pos.y) * 1.35, proctor.z - pos.z);
            if (dist <= radius) {
                const lost = Math.min(s.score, gameState.panicMode ? 65 : 45);
                triggerProctorStrike(proctor, s, lost, 0, null, -1);
            }
        });
    });
}, 200);

// 1 Saniyelik Ana Oyun Döngüsü (Son 30sn Panik Modu + Mezuniyet Podyumu + Ön Sıra Yerleşimi)
let passiveTick = 0;
setInterval(() => {
    const now = Date.now();
    passiveTick += 1;

    gameState.cheatPasses = gameState.cheatPasses.filter(cp => now - cp.createdAt < 3200);
    gameState.exitingStudents = gameState.exitingStudents.filter(ex => now - ex.startedAt < ex.durationMs);
    gameState.rivalries = gameState.rivalries.filter(r => r.expiresAt > now);
    gameState.fxEvents = gameState.fxEvents.filter(fx => now - fx.createdAt < 2500);

    if (gameState.cheatChain.count > 0 && (now - gameState.cheatChain.lastAt > 6500)) {
        gameState.cheatChain = { count: 0, lastAt: 0, seatIndices: [] };
    }
    if (gameState.worldEffect && now > gameState.worldEffect.expiresAt) {
        gameState.worldEffect = null;
    }

    // FAZ 1: MEZUNİYET PODYUMU -> YENİ TUR BAŞLANGICI
    if (gameState.phase === 'podium') {
        gameState.timeLeft -= 1;
        if (gameState.timeLeft <= 0) {
            const rankedStudents = gameState.seats.filter(Boolean).sort((a, b) => b.score - a.score);
            const topWinner = rankedStudents[0] || gameState.podiumWinners[0];
            const remainingStudents = rankedStudents.filter(s => !topWinner || s.userId !== topWinner.userId);

            gameState.phase = 'playing';
            gameState.round += 1;
            gameState.timeLeft = ROUND_DURATION;
            gameState.panicMode = false;
            gameState.proctors = [];
            gameState.proctorRecord = 0;
            gameState.podiumWinners = [];
            gameState.rivalries = [];
            gameState.seats = Array(MAX_SEATS).fill(null);

            // Kalan öğrencileri 0. indeksten (Tier 0 = En Ön Sıra, sonra Tier 1...) başlayarak oturt
            remainingStudents.forEach((s, frontSeatIdx) => {
                if (frontSeatIdx >= MAX_SEATS) return;
                s.seatIndex = frontSeatIdx;
                s.score = 10;
                s.cheatingUntil = 0;
                s.caughtUntil = 0;
                s.penaltyUntil = 0;
                s.shield = false;
                s.lastShieldMilestone = 0;
                s.isLeader = false;
                s.comboCount = 0;
                s.statusEffect = null;
                s.lastPopup = { text: `⭐ Ön Sıra #${frontSeatIdx + 1}`, color: '#38bdf8', id: now + frontSeatIdx };
                syncStudentVisualTiers(s);
                gameState.seats[frontSeatIdx] = s;
            });

            if (topWinner) {
                promoteToProctor(topWinner, 0);
            } else {
                triggerBanner(`TUR #${gameState.round} BAŞLADI!`, 'Amfi boş, "katıl" yazarak sıraya geç!', '#38bdf8');
            }
        }

        io.emit('state_update', {
            ...gameState,
            giftQueueLength: giftFocusQueue.length,
            flameQueueLength: flameFocusQueue.length
        });
        return;
    }

    // FAZ 2: NORMAL OYUN & SON 30 SANİYE PANİK MODU
    const wasPanic = gameState.panicMode;
    gameState.panicMode = gameState.timeLeft <= 30 && gameState.timeLeft > 0;
    if (gameState.panicMode && !wasPanic) {
        emitFx('panic_start', { text: '🚨 SON 30 SANİYE: 2x PUAN & ÇİFTE RİSK!', color: '#ef4444' });
        triggerBanner('🚨 SON 30 SANİYE PANİK MODU!', 'Tüm puanlar 2x • Gözetmen alanı %30 büyüdü!', '#ef4444');
    }

    // Gözetmen Pürüzsüz Koridor Devriyesi: Ön sıraların (Tier 0-2) önünde sağa-sola akıcı gezer!
    gameState.proctors.forEach(proctor => {
        proctor.patrolRadius = calculateProctorRadius(proctor.coins, gameState.panicMode);
        if (passiveTick % 10 === 0) {
            proctor.score = (proctor.score || 0) + (gameState.panicMode ? 4 : 2);
        }

        if (now > (proctor.attackingUntil || 0)) {
            const stepSpeed = gameState.panicMode ? 0.14 : 0.085;
            proctor.patrolAngle = (proctor.patrolAngle || 0) + (proctor.patrolDir || 1) * stepSpeed;
            if (proctor.patrolAngle > 0.48) {
                proctor.patrolAngle = 0.48;
                proctor.patrolDir = -1;
            } else if (proctor.patrolAngle < -0.48) {
                proctor.patrolAngle = -0.48;
                proctor.patrolDir = 1;
            }

            // %80 ön sıralar (radius 12.8 - 17.5), %20 orta sıralar
            const baseRad = (passiveTick % 15 < 12) ? 14.2 : 19.5;
            proctor.targetX = Math.sin(proctor.patrolAngle) * baseRad;
            proctor.targetZ = Math.cos(proctor.patrolAngle) * baseRad - 10;
        }

        proctor.x += (proctor.targetX - proctor.x) * 0.35;
        proctor.z += (proctor.targetZ - proctor.z) * 0.35;

        const distFromCenter = Math.hypot(proctor.x, proctor.z + 10);
        const approxTier = Math.max(0, Math.min(9, (distFromCenter - 13.5) / 2.3));
        proctor.y = 0.35 + approxTier * 0.72;
    });

    gameState.timeLeft -= 1;
    if (gameState.timeLeft <= 0) {
        const activeStudents = gameState.seats.filter(Boolean).sort((a, b) => b.score - a.score);
        if (activeStudents.length > 0) {
            gameState.phase = 'podium';
            gameState.timeLeft = PODIUM_DURATION;
            gameState.panicMode = false;
            gameState.podiumWinners = activeStudents.slice(0, 3).map((s, i) => ({
                rank: i + 1,
                userId: s.userId,
                nickname: s.nickname,
                score: s.score,
                color: s.color
            }));
            emitFx('podium_fanfare', { text: `🏆 TUR #${gameState.round} ŞAMPİYONU: ${activeStudents[0].nickname}!`, color: '#fbbf24' });
            triggerBanner(
                `🏆 TUR #${gameState.round} MEZUNİYET PODYUMU!`,
                `1. ${activeStudents[0].nickname} Başgözetmen Oluyor • Diğerleri Ön Sıraya Geçiyor!`,
                '#fbbf24'
            );
        } else {
            gameState.round += 1;
            gameState.timeLeft = ROUND_DURATION;
            gameState.panicMode = false;
            gameState.proctors = [];
            gameState.proctorRecord = 0;
            triggerBanner(`TUR #${gameState.round} BAŞLADI!`, 'Amfi boş, "katıl" yazarak sıraya geç!', '#38bdf8');
        }
    }

    io.emit('state_update', {
        ...gameState,
        giftQueueLength: giftFocusQueue.length,
        flameQueueLength: flameFocusQueue.length
    });
}, 1000);

function connectToTikTok(targetInput) {
    if (!targetInput) return;
    const cleanInput = String(targetInput).replace('@', '').trim();
    const isRoomId = /^\d+$/.test(cleanInput);
    connectedUsername = cleanInput;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (tiktokConnection) {
        try { tiktokConnection.disconnect(); } catch (e) {}
    }

    const label = isRoomId ? `Oda #${cleanInput}` : `@${cleanInput}`;
    connectionStatus = `${label} yayınına bağlanılıyor...`;
    io.emit('status_update', { connectedUsername, connectionStatus });

    const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    };

    tiktokConnection = new TikTokConnectorClass(isRoomId ? 'live_user' : cleanInput, {
        processInitialData: false,
        fetchRoomInfoOnConnect: false,
        enableExtendedGiftInfo: false,
        signApiKey: process.env.SIGN_API_KEY ? process.env.SIGN_API_KEY.trim() : undefined,
        webClientOptions: { headers: browserHeaders },
        wsClientOptions: { headers: browserHeaders }
    });

    const streakTracker = new Map();

    tiktokConnection.on('error', err => {
        console.log('TikTok bağlantı uyarısı:', err && err.message ? err.message : err);
    });

    tiktokConnection.on('disconnected', () => {
        console.log('TikTok bağlantısı koptu, 10 sn içinde tekrar denenecek...');
        connectionStatus = `Bağlantı koptu, yeniden deneniyor (${label})...`;
        io.emit('status_update', { connectedUsername, connectionStatus });
        reconnectTimer = setTimeout(() => connectToTikTok(cleanInput), 10000);
    });

    const connectPromise = isRoomId
        ? tiktokConnection.connect(cleanInput)
        : tiktokConnection.connect();

    connectPromise.then(() => {
        connectionStatus = `CANLI BAĞLI: ${label}`;
        console.log('TikTok canlı yayınına bağlandı:', label);
        io.emit('status_update', { connectedUsername, connectionStatus });
    }).catch(err => {
        const msg = err && err.message ? err.message : String(err);
        console.error('TikTok bağlantı hatası:', msg);
        if (msg.includes('Business plan')) {
            connectionStatus = `Render IP engeli: Yayın açıkken 19 haneli Room ID girin (Ctrl+U -> "roomId")`;
        } else {
            connectionStatus = `Yayın bekleniyor (${label}) - 10 sn içinde tekrar denenecek`;
        }
        io.emit('status_update', { connectedUsername, connectionStatus });
        reconnectTimer = setTimeout(() => connectToTikTok(cleanInput), 10000);
    });

    tiktokConnection.on('streamEnd', () => {
        console.log('Canlı yayın sona erdi.');
        connectionStatus = `Yayın sona erdi (${label})`;
        io.emit('status_update', { connectedUsername, connectionStatus });
    });

    tiktokConnection.on('member', data => {
        const u = extractTikTokUser(data);
        if (u.userId) {
            seenInRoomUsers.add(u.userId);
            touchUserActivity(u.userId);
        }
    });

    tiktokConnection.on('roomUser', data => {
        const list = (data && (data.ranks || data.ranksList)) || [];
        const viewerCount = Number(data && (data.viewerCount || data.totalUser || list.length) || 0);
        if (viewerCount > 0) lastKnownViewerCount = viewerCount;

        const currentIds = new Set();
        list.forEach(r => {
            const u = extractTikTokUser(r);
            if (u.userId) {
                currentIds.add(u.userId);
                seenInRoomUsers.add(u.userId);
                touchUserActivity(u.userId);
            }
        });

        if (list.length > 0 && lastKnownViewerCount > 0 && lastKnownViewerCount <= 18) {
            seenInRoomUsers.forEach(uid => {
                if (!currentIds.has(uid)) {
                    const strikes = (missingRoomUserStrikes.get(uid) || 0) + 1;
                    missingRoomUserStrikes.set(uid, strikes);
                    if (strikes >= 4) {
                        removeUserCompletely(uid, 'Yayından ayrıldı');
                    }
                } else {
                    missingRoomUserStrikes.delete(uid);
                }
            });
        }
    });

    tiktokConnection.on('chat', data => {
        const msgId = data.msgId || (data.common && data.common.msgId);
        if (msgId) {
            const idStr = String(msgId);
            if (seenChatIds.has(idStr)) return;
            seenChatIds.add(idStr);
            if (seenChatIds.size > 1000) seenChatIds.clear();
        }

        const rawComment = data.content || data.comment || data.text || '';
        const msg = String(rawComment).trim().toLocaleLowerCase('tr-TR');
        const user = extractTikTokUser(data);
        touchUserActivity(user.userId);

        if (msg === 'çık' || msg === 'cik' || msg === 'ayrıl' || msg === 'ayril') {
            removeUserCompletely(user.userId, 'Sınıftan ayrıldı');
            io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length, flameQueueLength: flameFocusQueue.length });
            return;
        }

        if (msg === 'katıl' || msg === 'katil' || msg === '1' || msg.includes('katıl') || msg.includes('katil')) {
            seatStudent(user, false, true);
            io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length, flameQueueLength: flameFocusQueue.length });
        }
    });

    tiktokConnection.on('like', data => {
        const user = extractTikTokUser(data);
        const likeCount = Number(data.count || data.likeCount || 1);
        handleLike(user, likeCount);
    });

    tiktokConnection.on('gift', data => {
        const user = extractTikTokUser(data);
        const giftObj = data.giftDetails || data.gift || {};
        const diamondValue = Number(data.diamondCount || giftObj.diamondCount || 1);
        const repeatCount = Number(data.repeatCount || data.comboCount || 1);
        const giftType = Number(data.giftType ?? giftObj.type ?? giftObj.giftType ?? 0);
        const giftId = data.giftId || giftObj.id || 0;
        const key = `${user.userId}_${giftId}`;

        if (giftType === 1 && !data.repeatEnd) {
            const prev = streakTracker.get(key) || 0;
            const delta = Math.max(0, repeatCount - prev);
            streakTracker.set(key, repeatCount);
            if (delta > 0) handleGift(user, diamondValue * delta);
        } else {
            const prev = streakTracker.get(key) || 0;
            const delta = Math.max(1, repeatCount - prev);
            streakTracker.delete(key);
            handleGift(user, diamondValue * delta);
        }
        io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length, flameQueueLength: flameFocusQueue.length });
    });
}

if (connectedUsername) {
    connectToTikTok(connectedUsername);
}

io.on('connection', socket => {
    socket.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length, flameQueueLength: flameFocusQueue.length });
    socket.emit('status_update', { connectedUsername, connectionStatus });

    socket.on('connect_tiktok', username => connectToTikTok(username));

    socket.on('sim_event', payload => {
        if (payload.type === 'join') {
            const botName = payload.nickname || pickUniqueBotName();
            seatStudent({
                userId: payload.userId || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                nickname: botName,
                avatar: ''
            });
        } else if (payload.type === 'fill_20') {
            for (let i = 0; i < 20; i++) {
                const botName = pickUniqueBotName();
                seatStudent({
                    userId: `bot_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                    nickname: botName,
                    avatar: ''
                }, i > 0);
            }
        } else if (payload.type === 'leave_one') {
            const seated = gameState.seats.filter(Boolean);
            if (seated.length > 0) {
                const leaver = seated[Math.floor(Math.random() * seated.length)];
                removeStudentFromHall(leaver.seatIndex, 'Yayından ayrıldı');
            }
        } else if (payload.type === 'like') {
            const seated = gameState.seats.filter(Boolean);
            if (seated.length > 0) {
                handleLike(seated[Math.floor(Math.random() * seated.length)], 15);
            }
        } else if (payload.type === 'boost_flame') {
            // Sınıftaki öğrencileri sırayla alevlendirir ve her birini sırayla kameraya getirir!
            const seated = gameState.seats.filter(Boolean);
            if (seated.length > 0) {
                const unlit = seated.filter(s => (s.flameLevel || 0) === 0);
                const pool = unlit.length > 0 ? unlit : seated;
                const batch = pool.slice(0, Math.min(3, pool.length));
                batch.forEach(target => {
                    target.score += 35;
                    target.studyingUntil = Date.now() + 4500;
                    syncStudentVisualTiers(target);
                    target.lastPopup = { text: `🔥 +35 ALEV ALDI!`, color: '#f97316', id: Date.now() + Math.random() };
                    emitFx('flame_up', { seatIndex: target.seatIndex, text: '🔥 ALEV ALDI!', color: '#f97316' });
                    scheduleCameraFocus({
                        isGift: false,
                        coins: 0,
                        priority: 3,
                        type: 'flame',
                        userId: target.userId,
                        seatIndex: target.seatIndex,
                        title: `🔥 ${target.nickname} ALEV ALDI!`,
                        subtitle: `Sıra #${target.seatIndex + 1} • Puan: ${target.score} (Seviye ${target.flameLevel})`,
                        color: '#f97316',
                        baseDurationMs: 2500
                    });
                });
                updateLeaderCrown();
            }
        } else if (payload.type === 'gift') {
            const seated = gameState.seats.filter(Boolean);
            const fallbackUser = {
                userId: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                nickname: pickUniqueBotName(),
                avatar: ''
            };
            const actor = (payload.coins < 15 && seated.length > 0)
                ? seated[Math.floor(Math.random() * seated.length)]
                : fallbackUser;
            handleGift(actor, payload.coins);
        } else if (payload.type === 'cheat_chain') {
            const seated = gameState.seats.filter(Boolean);
            for (let i = 0; i < Math.min(4, seated.length); i++) {
                handleGift(seated[i], 1);
            }
        } else if (payload.type === 'panic_test') {
            gameState.phase = 'playing';
            gameState.timeLeft = 28;
        } else if (payload.type === 'end_round') {
            gameState.phase = 'playing';
            gameState.timeLeft = 1;
        }
        io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length, flameQueueLength: flameFocusQueue.length });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`3D Amfi Sınav Salonu Hazır: http://localhost:${PORT}?test=1`);
});
