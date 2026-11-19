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

// 9:16 Dikey Telefon Kadrajına Tam Sığan 250 Kişilik 8 Kademeli Amfi Düzeni
const TIER_COUNTS = [20, 24, 28, 31, 34, 36, 38, 39];
const SEAT_LAYOUT = [];

(function buildAmphitheaterLayout() {
    let idx = 0;
    for (let tier = 0; tier < TIER_COUNTS.length; tier++) {
        const count = TIER_COUNTS[tier];
        const radius = 10.5 + tier * 2.95;
        const y = 0.35 + tier * 0.78;
        const maxAngle = Math.PI * 0.35;

        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0.5 : i / (count - 1);
            let angle = -maxAngle + t * (maxAngle * 2);
            if (angle > -0.055 && angle < 0.055) angle += (angle >= 0 ? 0.045 : -0.045);

            const x = Math.sin(angle) * radius;
            const z = Math.cos(angle) * radius - 7;
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

let tiktokConnection = null;
let reconnectTimer = null;
let connectedUsername = (process.env.TIKTOK_ROOM_ID || process.env.TIKTOK_USERNAME || '').replace('@', '').trim();
let connectionStatus = 'Bağlantı bekleniyor (Test Modu Aktif)';

// Çift Katmanlı Kamera Kuyruğu
let activeFocus = null;
let giftFocusQueue = [];
let freeFocusQueue = [];

const likeRateLimiter = new Map();
const likeCamCooldown = new Map();
const alreadySeatedCamCooldown = new Map();
const reminderCooldown = new Map();
const seenChatIds = new Set();

// Gerçek yayın çıkış tespiti için izleyici listesi takibi
const seenInRoomUsers = new Set();
const missingRoomUserStrikes = new Map();
let lastKnownViewerCount = 0;

let gameState = {
    round: 1,
    timeLeft: ROUND_DURATION,
    seatLayout: SEAT_LAYOUT,
    seats: Array(MAX_SEATS).fill(null),
    exitingStudents: [],
    proctors: [],
    proctorRecord: 0,
    activeFocus: null,
    banner: null,
    cheatPasses: [],
    worldEffect: null
};

function calculateProctorRadius(coins) {
    const c = Math.max(0, Number(coins) || 0);
    return Number(Math.min(16.5, 7.2 + Math.sqrt(c) * 0.65).toFixed(2));
}

function getFlameLevel(score) {
    if (score >= 750) return 5; // Beyaz-Altın Süpernova Alevi
    if (score >= 450) return 4; // Mor Kozmik Alev
    if (score >= 250) return 3; // Mavi Plazma Alevi
    if (score >= 120) return 2; // Kızıl-Turuncu Güçlü Alev
    if (score >= 50) return 1;  // Turuncu-Sarı Başlangıç Alevi
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
        baseDurationMs = 3000
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

    if (isGift) {
        giftFocusQueue.push(item);
        giftFocusQueue.sort((a, b) => b.coins - a.coins || a.createdAt - b.createdAt);

        if (activeFocus && !activeFocus.isGift) {
            const nextGift = giftFocusQueue.shift();
            const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
            activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
            gameState.activeFocus = activeFocus;
            return;
        }

        if (activeFocus && activeFocus.isGift && coins > activeFocus.coins && (now - activeFocus.startedAt) >= 1200) {
            const nextGift = giftFocusQueue.shift();
            const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
            activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
            gameState.activeFocus = activeFocus;
            return;
        }

        if (!activeFocus) {
            const nextGift = giftFocusQueue.shift();
            const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
            activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
            gameState.activeFocus = activeFocus;
        }
    } else {
        if (giftFocusQueue.length > 0 || (activeFocus && activeFocus.isGift)) {
            return;
        }
        if (freeFocusQueue.some(q => q.userId === userId && q.type === type)) {
            return;
        }
        if (freeFocusQueue.length >= 3) {
            if (priority > freeFocusQueue[freeFocusQueue.length - 1].priority) {
                freeFocusQueue.pop();
            } else {
                return;
            }
        }

        freeFocusQueue.push(item);
        freeFocusQueue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

        if (!activeFocus) {
            const nextFree = freeFocusQueue.shift();
            activeFocus = { ...nextFree, startedAt: now, expiresAt: now + nextFree.baseDurationMs };
            gameState.activeFocus = activeFocus;
        }
    }
}

function getAdaptiveGiftDuration(waitingCount, baseMs) {
    if (waitingCount >= 7) return 1400;
    if (waitingCount >= 3) return 2000;
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

    freeFocusQueue = freeFocusQueue.filter(q => now - q.createdAt < 8000);
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

// Her zaman fiziksel olarak EN YAKINDAKİ komşu öğrenciyi bulur
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

    student.score = Math.max(0, student.score - penalty);
    student.cheatingUntil = 0;
    student.caughtUntil = now + 2400;
    student.penaltyUntil = now + 4500;
    student.statusEffect = 'caught';
    student.statusUntil = now + 4500;
    student.lastPopup = { text: `💥 -${penalty} YAKALANDI!`, color: '#ef4444', id: now + Math.random() };
    syncStudentVisualTiers(student);

    // Gözetmen sıranın hemen yanına atılır, cetvelle vurur ve Gözetmen Puanı kazanır
    proctor.x = pos.x + (pos.x >= 0 ? -1.15 : 1.15);
    proctor.z = pos.z + 0.85;
    proctor.y = pos.y;
    proctor.targetX = proctor.x;
    proctor.targetZ = proctor.z;
    proctor.catches += 1;
    proctor.score = (proctor.score || 0) + 35;
    proctor.attackingUntil = now + 1500;
    proctor.attackTargetSeat = sIdx;
    proctor.lastPopup = { text: `+35 Gözetmen Puanı!`, color: '#fbbf24', id: now + Math.random() };

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
        subtitle: `${student.nickname} (-${penalty} Puan) • ${proctor.nickname} +35 Gözetmen Puanı!`,
        color: '#ef4444',
        baseDurationMs: 3200
    });
}

function checkProctorProximityPenalty(giverSeatIdx, receiverSeatIdx, actorUser, coins, isSabotage = false) {
    if (gameState.proctors.length === 0) return false;
    const targets = [giverSeatIdx, receiverSeatIdx].filter(i => i >= 0 && gameState.seats[i]);

    let anyoneCaught = false;
    for (const proctor of gameState.proctors) {
        const radius = proctor.patrolRadius || calculateProctorRadius(proctor.coins);
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
                    baseDurationMs: 2600
                });
            }
        }
        return existingIdx;
    }
    if (gameState.proctors.some(p => p.userId === user.userId)) {
        touchUserActivity(user.userId);
        return -1;
    }

    const emptyIndices = [];
    for (let i = 0; i < MAX_SEATS; i++) {
        if (!gameState.seats[i]) emptyIndices.push(i);
    }
    if (emptyIndices.length === 0) return -1;

    const chosenSeat = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
    const now = Date.now();
    const newStudent = {
        seatIndex: chosenSeat,
        userId: user.userId,
        nickname: user.nickname || user.userId,
        avatar: user.avatar || '',
        color: getRandomAvatarColor(user.userId),
        score: 10,
        flameLevel: 0,
        penaltyLevel: 0,
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

    const occupiedCount = gameState.seats.filter(Boolean).length;
    console.log(`[OYUN] + ${user.nickname} Sıra #${chosenSeat + 1} koltuğuna oturdu! (Toplam: ${occupiedCount}/250)`);

    if (!skipCamera) {
        scheduleCameraFocus({
            isGift: false,
            coins: 0,
            priority: 2,
            type: 'join',
            userId: user.userId,
            seatIndex: chosenSeat,
            title: `🚪 ${user.nickname} Sınıfa Girdi!`,
            subtitle: `Amfi Sıra #${chosenSeat + 1} koltuğuna yürüyor...`,
            color: '#34d399',
            baseDurationMs: 3600
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
    console.log(`[OYUN] - ${student.nickname} Sıra #${seatIdx + 1} koltuğundan ayrıldı (${reasonText}).`);

    gameState.exitingStudents.push({
        id: now + Math.random(),
        userId: student.userId,
        nickname: student.nickname,
        avatar: student.avatar,
        color: student.color,
        score: student.score,
        fromSeatIndex: seatIdx,
        startedAt: now,
        durationMs: 4200
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
        baseDurationMs: 3400
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

    const existingProctor = gameState.proctors.find(p => p.userId === user.userId);
    if (existingProctor) {
        existingProctor.coins = Math.max(existingProctor.coins, coins);
        existingProctor.patrolRadius = calculateProctorRadius(existingProctor.coins);
        existingProctor.lastActiveAt = Date.now();
    } else {
        const startAngle = (Math.random() - 0.5) * 1.1;
        const startRadius = 13 + Math.random() * 9;
        const newProctor = {
            userId: user.userId,
            nickname: user.nickname || user.userId,
            avatar: user.avatar || '',
            color: getRandomAvatarColor(user.userId),
            coins,
            score: carriedScore,
            patrolRadius: calculateProctorRadius(coins),
            lastActiveAt: Date.now(),
            x: Math.sin(startAngle) * startRadius,
            y: 1.5,
            z: Math.cos(startAngle) * startRadius - 7,
            targetX: 0,
            targetZ: 5,
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
            triggerBanner('TUR BİRİNCİSİ BAŞGÖZETMEN!', `${newProctor.nickname} en yüksek ortalamayla gözetmen oldu!`, '#38bdf8');
        }
    }

    if (coins > 0) {
        const pObj = gameState.proctors.find(p => p.userId === user.userId);
        const rad = pObj ? pObj.patrolRadius : calculateProctorRadius(coins);
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'proctor',
            userId: user.userId,
            proctorUserId: user.userId,
            title: `👮 GÖZETMEN ${user.nickname} (${coins} Jeton)`,
            subtitle: `Gözetleme Alanı: ${rad}m • Devriye başladı!`,
            color: '#f59e0b',
            baseDurationMs: 3600
        });
    }
}

function handleLike(user, count = 1) {
    const now = Date.now();
    const rl = likeRateLimiter.get(user.userId) || { windowStart: now, gained: 0 };
    if (now - rl.windowStart > 3000) {
        rl.windowStart = now;
        rl.gained = 0;
    }

    // KURAL: Sınıfa girmek için önce sohbete "katıl" yazmak şarttır; beğeni otomatik oturtmaz!
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

    const prevFlame = student.flameLevel || 0;
    student.score += allowedGain;
    student.studyingUntil = now + 3000;
    syncStudentVisualTiers(student);

    const flameNames = ['', '🔥 ALEV ALDI!', '🔥🔥 KIZIL ALEV!', '💙 MAVİ PLAZMA!', '💜 MOR ALEV!', '👑 SÜPERNOVA!'];
    const popupText = student.flameLevel > prevFlame
        ? `+${allowedGain} ${flameNames[student.flameLevel]}`
        : `+${allowedGain} Çalıştı`;

    student.lastPopup = { text: popupText, color: '#4ade80', id: now + Math.random() };

    const lastCam = likeCamCooldown.get(user.userId) || 0;
    if (now - lastCam > 15000 || student.flameLevel > prevFlame) {
        likeCamCooldown.set(user.userId, now);
        scheduleCameraFocus({
            isGift: false,
            coins: 0,
            priority: student.flameLevel > prevFlame ? 2 : 1,
            type: 'study',
            userId: user.userId,
            seatIndex: idx,
            title: student.flameLevel > prevFlame
                ? `${flameNames[student.flameLevel]} ${student.nickname}!`
                : `📚 ${student.nickname} Ders Çalışıyor!`,
            subtitle: `Beğeni gönderdi (+${allowedGain} Puan • Toplam: ${student.score})`,
            color: '#4ade80',
            baseDurationMs: 2400
        });
    }
}

function handleGift(user, coins) {
    const now = Date.now();
    touchUserActivity(user.userId);

    // Gözetmen olma veya 100+ Jeton Kader Değiştirme hediyesi
    if (coins >= 100 || (coins > gameState.proctorRecord && coins >= 15) || (coins === gameState.proctorRecord && coins >= 15)) {
        promoteToProctor(user, coins);

        if (coins >= 100) {
            const isAmnesty = Math.random() > 0.5;
            gameState.worldEffect = {
                id: now + Math.random(),
                type: isAmnesty ? 'amnesty' : 'discipline',
                expiresAt: now + 4500
            };
            gameState.seats.forEach(s => {
                if (!s) return;
                if (isAmnesty) {
                    s.score += 50;
                    s.statusEffect = 'cheer';
                    s.statusUntil = now + 4000;
                    s.lastPopup = { text: '+50 GENEL AF!', color: '#34d399', id: now + Math.random() };
                } else if (s.cheatingUntil > now) {
                    s.score = Math.max(0, s.score - 60);
                    s.cheatingUntil = 0;
                    s.penaltyUntil = now + 4500;
                    s.statusEffect = 'caught';
                    s.statusUntil = now + 4000;
                    s.lastPopup = { text: '-60 DİSİPLİN!', color: '#f87171', id: now + Math.random() };
                }
                syncStudentVisualTiers(s);
            });
            triggerBanner(
                isAmnesty ? 'KADER DEĞİŞTİ: GENEL AF!' : 'KADER DEĞİŞTİ: SIKI YÖNETİM!',
                `${user.nickname} (${coins} Jeton) tüm amfinin kaderini değiştirdi!`,
                isAmnesty ? '#10b981' : '#ef4444'
            );
        }
        return;
    }

    // Aktif gözetmen hediye atarsa gözetleme gücü (alanı) ve gözetmen puanı büyür!
    const activeProctor = gameState.proctors.find(p => p.userId === user.userId);
    if (activeProctor) {
        activeProctor.coins += coins;
        activeProctor.score = (activeProctor.score || 0) + coins * 2;
        activeProctor.patrolRadius = calculateProctorRadius(activeProctor.coins);
        activeProctor.lastPopup = { text: `Alan: ${activeProctor.patrolRadius}m (+${coins * 2} Puan)`, color: '#fbbf24', id: now };
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
            baseDurationMs: 2800
        });
        return;
    }

    // KURAL: Sınıfa girmek için önce sohbete "katıl" yazmak şarttır; hediye otomatik sıraya oturtmaz!
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

    // 50+ Jeton: Cevap Anahtarı
    if (coins >= 50) {
        actor.score += 120;
        actor.statusEffect = 'answer_key';
        actor.statusUntil = now + 4500;
        actor.lastPopup = { text: '+120 CEVAP ANAHTARI!', color: '#fbbf24', id: now };
        syncStudentVisualTiers(actor);

        const victims = occupied.sort(() => 0.5 - Math.random()).slice(0, 5);
        victims.forEach(v => {
            v.score = Math.max(0, v.score - 25);
            v.penaltyUntil = now + 4500;
            v.statusEffect = 'burned';
            v.statusUntil = now + 4500;
            v.lastPopup = { text: '-25 Kağıt Yandı!', color: '#f87171', id: now + Math.random() };
            syncStudentVisualTiers(v);
        });
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'answer_key',
            userId: user.userId,
            seatIndex: idx,
            title: `🔑 ${actor.nickname} (${coins} Jeton)`,
            subtitle: `Cevap anahtarını ele geçirdi (+120) ve 5 rakibi yaktı!`,
            color: '#fbbf24',
            baseDurationMs: 3400
        });
        return;
    }

    // 10+ Jeton: İspiyonla
    if (coins >= 10) {
        const cheaters = occupied.filter(s => s.cheatingUntil > now);
        const target = cheaters.length > 0
            ? cheaters[Math.floor(Math.random() * cheaters.length)]
            : occupied.sort((a, b) => b.score - a.score)[0];

        actor.score += 25;
        actor.statusEffect = 'snitch';
        actor.statusUntil = now + 3500;
        actor.lastPopup = { text: '+25 İspiyon Ödülü', color: '#38bdf8', id: now };
        syncStudentVisualTiers(actor);

        if (target) {
            const penalty = cheaters.length > 0 ? 45 : 25;
            if (gameState.proctors.length > 0) {
                triggerProctorStrike(gameState.proctors[0], target, penalty, coins, user, idx);
            } else {
                target.score = Math.max(0, target.score - penalty);
                target.cheatingUntil = 0;
                target.caughtUntil = now + 2200;
                target.penaltyUntil = now + 4500;
                target.statusEffect = 'caught';
                target.statusUntil = now + 4500;
                target.lastPopup = { text: `-${penalty} İSPİYONLANDI!`, color: '#ef4444', id: now };
                syncStudentVisualTiers(target);

                scheduleCameraFocus({
                    isGift: true,
                    coins,
                    priority: 3,
                    type: 'snitch',
                    userId: user.userId,
                    seatIndex: idx,
                    targetSeatIndex: target.seatIndex,
                    title: `📣 ${actor.nickname} İspiyonladı (${coins} Jeton)!`,
                    subtitle: `${target.nickname} yakalandı (-${penalty} Puan)!`,
                    color: '#38bdf8',
                    baseDurationMs: 3000
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
                subtitle: `İspiyon ödülü kazandı (+25 Puan)!`,
                color: '#38bdf8',
                baseDurationMs: 2600
            });
        }
        return;
    }

    // 5+ Jeton: En Yakındaki Komşuya Yanlış Kopya Atma (Sabotaj)
    if (coins >= 5) {
        const victim = findNearestNeighborSeat(idx);
        if (victim) {
            actor.cheatingUntil = now + 5000;
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
                victim.score = Math.max(0, victim.score - 20);
                victim.penaltyUntil = now + 4500;
                victim.statusEffect = 'wrong_cheat';
                victim.statusUntil = now + 4500;
                victim.lastPopup = { text: '-20 Yanlış Kopya!', color: '#fb7185', id: now };
                syncStudentVisualTiers(victim);

                actor.score += 10;
                syncStudentVisualTiers(actor);

                scheduleCameraFocus({
                    isGift: true,
                    coins,
                    priority: 2,
                    type: 'sabotage',
                    userId: user.userId,
                    seatIndex: idx,
                    targetSeatIndex: victim.seatIndex,
                    title: `😈 ${actor.nickname} En Yakınına Yanlış Kopya Attı!`,
                    subtitle: `Yanındaki ${victim.nickname} yanlış kopyayı aldı (-20 Puan)!`,
                    color: '#fb7185',
                    baseDurationMs: 2800
                });
            }
        } else {
            actor.score += 15;
            syncStudentVisualTiers(actor);
            scheduleCameraFocus({
                isGift: true,
                coins,
                priority: 2,
                type: 'sabotage',
                userId: user.userId,
                seatIndex: idx,
                title: `😈 ${actor.nickname} (${coins} Jeton)`,
                subtitle: `Bonus puan kazandı (+15 Puan)!`,
                color: '#fb7185',
                baseDurationMs: 2500
            });
        }
        return;
    }

    // 1-4 Jeton: En Yakındaki Komşudan Kopya Çekme
    const neighbor = findNearestNeighborSeat(idx);
    actor.cheatingUntil = now + 6000;
    actor.cheatTargetSeat = neighbor ? neighbor.seatIndex : -1;

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
        const gain = 20;
        actor.score += gain;
        actor.lastPopup = { text: `+${gain} Kopya Aldı!`, color: '#facc15', id: now };
        syncStudentVisualTiers(actor);

        if (neighbor) {
            neighbor.lastPopup = { text: 'Kopya Verdi!', color: '#fde047', id: now + 0.1 };
        }
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 2,
            type: 'cheat',
            userId: user.userId,
            seatIndex: idx,
            targetSeatIndex: neighbor ? neighbor.seatIndex : -1,
            title: `👀 ${actor.nickname} Kopya Çekiyor (${coins} Jeton)!`,
            subtitle: neighbor ? `En yakındaki ${neighbor.nickname} kağıdından çekti (+${gain})` : `Gizlice kopya çekti (+${gain})`,
            color: '#facc15',
            baseDurationMs: 2700
        });
    }
}

// 200ms Gözetmen Devriye Yakalama & Kamera Kuyruğu Döngüsü
setInterval(() => {
    const now = Date.now();
    processFocusQueues();

    gameState.proctors.forEach(proctor => {
        const radius = proctor.patrolRadius || calculateProctorRadius(proctor.coins);
        gameState.seats.forEach(s => {
            if (!s || s.cheatingUntil <= now) return;
            const pos = SEAT_LAYOUT[s.seatIndex];
            const dist = Math.hypot(proctor.x - pos.x, (proctor.y - pos.y) * 1.35, proctor.z - pos.z);
            if (dist <= radius) {
                const lost = Math.min(s.score, 45);
                triggerProctorStrike(proctor, s, lost, 0, null, -1);
            }
        });
    });
}, 200);

// 1 Saniyelik Ana Oyun Döngüsü (Süreden dolayı kimse sınıftan atılmaz!)
let passiveTick = 0;
setInterval(() => {
    const now = Date.now();
    passiveTick += 1;

    gameState.cheatPasses = gameState.cheatPasses.filter(cp => now - cp.createdAt < 3200);
    gameState.exitingStudents = gameState.exitingStudents.filter(ex => now - ex.startedAt < ex.durationMs);
    if (gameState.worldEffect && now > gameState.worldEffect.expiresAt) {
        gameState.worldEffect = null;
    }

    // Gözetmen devriye hareketi ve her 10 saniyede +2 devriye puanı
    gameState.proctors.forEach(proctor => {
        if (passiveTick % 10 === 0) {
            proctor.score = (proctor.score || 0) + 2;
        }
        if (now > (proctor.attackingUntil || 0) && Math.random() < 0.32) {
            const angle = (Math.random() - 0.5) * 1.3;
            const radius = 10.5 + Math.random() * 20;
            proctor.targetX = Math.sin(angle) * radius;
            proctor.targetZ = Math.cos(angle) * radius - 7;
        }
        proctor.x += (proctor.targetX - proctor.x) * 0.22;
        proctor.z += (proctor.targetZ - proctor.z) * 0.22;

        const distFromCenter = Math.hypot(proctor.x, proctor.z + 7);
        const approxTier = Math.max(0, Math.min(7, (distFromCenter - 10.5) / 2.95));
        proctor.y = 0.35 + approxTier * 0.78;
    });

    gameState.timeLeft -= 1;
    if (gameState.timeLeft <= 0) {
        const activeStudents = gameState.seats.filter(Boolean).sort((a, b) => b.score - a.score);
        gameState.proctors = [];
        gameState.proctorRecord = 0;
        gameState.round += 1;
        gameState.timeLeft = ROUND_DURATION;

        if (activeStudents.length > 0) {
            promoteToProctor(activeStudents[0], 0);
        } else {
            triggerBanner(`TUR #${gameState.round} BAŞLADI!`, 'Amfi boş, "katıl" yazarak sıraya geç!', '#38bdf8');
        }

        gameState.seats.forEach(s => {
            if (s) {
                s.score = 10;
                s.cheatingUntil = 0;
                s.caughtUntil = 0;
                s.penaltyUntil = 0;
                s.statusEffect = null;
                syncStudentVisualTiers(s);
            }
        });
    }

    io.emit('state_update', {
        ...gameState,
        giftQueueLength: giftFocusQueue.length
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

    // TikTok yayın bitişi kontrolü
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

    // Odadaki aktif izleyici listesi üzerinden gerçek ayrılma tespiti
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

        // Küçük odalarda (<= 18 izleyici) TikTok listedeki herkesi gönderir;
        // daha önce listede olup art arda 4 güncellemede kaybolan izleyici yayından çıkmış demektir.
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
        console.log(`[SOHBET] ${user.nickname}: ${rawComment}`);

        if (msg === 'çık' || msg === 'cik' || msg === 'ayrıl' || msg === 'ayril') {
            removeUserCompletely(user.userId, 'Sınıftan ayrıldı');
            io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length });
            return;
        }

        if (msg === 'katıl' || msg === 'katil' || msg === '1' || msg.includes('katıl') || msg.includes('katil')) {
            seatStudent(user, false, true);
            io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length });
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
        io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length });
    });
}

if (connectedUsername) {
    connectToTikTok(connectedUsername);
}

io.on('connection', socket => {
    socket.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length });
    socket.emit('status_update', { connectedUsername, connectionStatus });

    socket.on('connect_tiktok', username => connectToTikTok(username));

    socket.on('sim_event', payload => {
        const randomNum = Math.floor(100 + Math.random() * 900);
        const testUser = {
            userId: payload.userId || `ogrenci_${randomNum}`,
            nickname: payload.nickname || `Öğrenci_${randomNum}`,
            avatar: ''
        };

        if (payload.type === 'join') {
            seatStudent(testUser);
        } else if (payload.type === 'fill_20') {
            for (let i = 0; i < 20; i++) {
                const n = Math.floor(100 + Math.random() * 900);
                seatStudent({ userId: `bot_${n}_${i}`, nickname: `Aday_${n}`, avatar: '' }, i > 0);
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
            const seated = gameState.seats.filter(Boolean);
            if (seated.length > 0) {
                const target = seated[Math.floor(Math.random() * seated.length)];
                handleLike(target, 15);
                target.score += 75;
                syncStudentVisualTiers(target);
                target.lastPopup = { text: `🔥 +90 Süper Çalışma!`, color: '#f97316', id: Date.now() };
            }
        } else if (payload.type === 'gift') {
            const seated = gameState.seats.filter(Boolean);
            const actor = (payload.coins < 15 && seated.length > 0)
                ? seated[Math.floor(Math.random() * seated.length)]
                : testUser;
            handleGift(actor, payload.coins);
        } else if (payload.type === 'gift_storm') {
            const coinsList = [1, 5, 10, 50];
            coinsList.forEach((c, idx) => {
                const seated = gameState.seats.filter(Boolean);
                const actor = seated[idx % seated.length] || { userId: `bagisci_${idx}`, nickname: `Bağışçı_${idx}`, avatar: '' };
                handleGift(actor, c);
            });
        } else if (payload.type === 'end_round') {
            gameState.timeLeft = 1;
        }
        io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`3D Amfi Sınav Salonu Hazır: http://localhost:${PORT}?test=1`);
});
