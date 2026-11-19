const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_SEATS = 250;
const ROUND_DURATION = 240; // 4 dakika
const INACTIVITY_TIMEOUT_MS = 180000; // 3 dakika etkileşimsiz kalan yayından ayrılmış sayılır

// 250 Kişilik Basamaklı Yarım Daire Amfi Koordinatları (8 Kademe)
const TIER_COUNTS = [20, 24, 28, 31, 34, 36, 38, 39];
const SEAT_LAYOUT = [];

(function buildAmphitheaterLayout() {
    let idx = 0;
    for (let tier = 0; tier < TIER_COUNTS.length; tier++) {
        const count = TIER_COUNTS[tier];
        const radius = 11.5 + tier * 3.5;
        const y = 0.4 + tier * 0.72;
        const maxAngle = Math.PI * 0.43;

        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0.5 : i / (count - 1);
            let angle = -maxAngle + t * (maxAngle * 2);
            if (angle > -0.06 && angle < 0.06) angle += (angle >= 0 ? 0.05 : -0.05);

            const x = Math.sin(angle) * radius;
            const z = Math.cos(angle) * radius - 6;
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
let connectedUsername = process.env.TIKTOK_USERNAME || '';
let connectionStatus = 'Bağlantı bekleniyor (Test Modu Aktif)';

// ÇİFT KATMANLI KAMERA KUYRUĞU
// 1) giftFocusQueue: Jeton/hediye atan herkes %100 garantili olarak sıraya girer, ASLA silinmez/engellenmez.
// 2) freeFocusQueue: Katıl, Ayrıl, Beğeni gibi ücretsiz etkileşimler hediye yokken sırayla gösterilir.
let activeFocus = null;
let giftFocusQueue = [];
let freeFocusQueue = [];

const likeRateLimiter = new Map();
const likeCamCooldown = new Map();

let gameState = {
    round: 1,
    timeLeft: ROUND_DURATION,
    seatLayout: SEAT_LAYOUT,
    seats: Array(MAX_SEATS).fill(null),
    exitingStudents: [], // Sınıftan yürüyerek çıkan karakterler (4.2 sn animasyon)
    proctors: [],
    proctorRecord: 0,
    activeFocus: null,
    banner: null,
    cheatPasses: [],
    worldEffect: null // 'amnesty' veya 'discipline' dalgası
};

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
    const idx = findStudentByUserId(userId);
    if (idx !== -1 && gameState.seats[idx]) {
        gameState.seats[idx].lastActiveAt = Date.now();
    }
    const proctor = gameState.proctors.find(p => p.userId === userId);
    if (proctor) {
        proctor.lastActiveAt = Date.now();
    }
}

// Garantili Kamera Odak Yöneticisi
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
        createdAt: now,
        shownMs: 0
    };

    if (isGift) {
        // KURAL: Jeton/hediye atan kişi ASLA engellenmez ve kuyruktan atılmaz!
        giftFocusQueue.push(item);
        // Yüksek jeton atanlar öne geçer, eşit jetonlarda ilk atan önce gösterilir
        giftFocusQueue.sort((a, b) => b.coins - a.coins || a.createdAt - b.createdAt);

        // Eğer şu an ekranda ÜCRETSİZ bir olay (katıl/ayrıl/beğeni) varsa, ANINDA kes ve hediye atana geç!
        if (activeFocus && !activeFocus.isGift) {
            const nextGift = giftFocusQueue.shift();
            const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
            activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
            gameState.activeFocus = activeFocus;
            return;
        }

        // Eğer şu an daha düşük jetonlu bir hediye ekrandaysa ve en az 1.2 sn gösterildiyse, yüksek jetonluya geç
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
        // Ücretsiz etkileşim (katıl, ayrıl, beğeni)
        // Zaten hediye kuyruğunda bekleyen varsa ücretsiz olay kamerayı meşgul etmez
        if (giftFocusQueue.length > 0 || (activeFocus && activeFocus.isGift)) {
            return;
        }

        // Aynı kişinin ücretsiz olayı zaten kuyrukta varsa tekrar ekleme
        if (freeFocusQueue.some(q => q.userId === userId && q.type === type)) {
            return;
        }

        // Ücretsiz kuyrukta en fazla 3 olay tut (spam birikmesini önler)
        if (freeFocusQueue.length >= 3) {
            // Ayrılma/katılma gibi animasyonları beğeninin önüne al
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

// Hediye yoğunluğuna göre süre ayarı: Kimseyi atlamadan herkesi akıcı şekilde gösterir
function getAdaptiveGiftDuration(waitingCount, baseMs) {
    if (waitingCount >= 7) return 1400; // Çok yoğun hediye yağmuru: hızlı ama herkes görünür
    if (waitingCount >= 3) return 2000; // Orta yoğunluk
    return baseMs; // Normal akış: 2.8 - 3.6 saniye detaylı çekim
}

function processFocusQueues() {
    const now = Date.now();
    if (activeFocus && now < activeFocus.expiresAt) {
        return;
    }

    // 1. Öncelik HER ZAMAN VIP Hediye Kuyruğundadır
    if (giftFocusQueue.length > 0) {
        const nextGift = giftFocusQueue.shift();
        const duration = getAdaptiveGiftDuration(giftFocusQueue.length, nextGift.baseDurationMs);
        activeFocus = { ...nextGift, startedAt: now, expiresAt: now + duration };
        gameState.activeFocus = activeFocus;
        return;
    }

    // 2. Hediye yoksa ücretsiz etkileşim animasyonlarını sırayla göster (8 sn'den eski bayatları temizle)
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

// En Yakın Komşuyu Bulma (3D Fiziksel Mesafeye Göre)
function findNearestNeighborSeat(actorSeatIdx, actorScore) {
    const posA = SEAT_LAYOUT[actorSeatIdx];
    const candidates = [];

    for (let i = 0; i < MAX_SEATS; i++) {
        if (i === actorSeatIdx || !gameState.seats[i]) continue;
        const posB = SEAT_LAYOUT[i];
        const dist = Math.hypot(posA.x - posB.x, posA.y - posB.y, posA.z - posB.z);
        candidates.push({ student: gameState.seats[i], dist });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.dist - b.dist);

    const closestFour = candidates.slice(0, 4);
    const higherInNeighborhood = closestFour.find(c => c.student.score > actorScore);
    return higherInNeighborhood ? higherInNeighborhood.student : closestFour[0].student;
}

// Gözetmen Yakınlık Kontrolü
function checkProctorProximityPenalty(giverSeatIdx, receiverSeatIdx, actorUser, coins, isSabotage = false) {
    if (gameState.proctors.length === 0) return false;
    const now = Date.now();
    const targets = [giverSeatIdx, receiverSeatIdx].filter(i => i >= 0 && gameState.seats[i]);

    let anyoneCaught = false;
    for (const proctor of gameState.proctors) {
        for (const sIdx of targets) {
            const student = gameState.seats[sIdx];
            if (!student) continue;
            const pos = SEAT_LAYOUT[sIdx];
            const dist = Math.hypot(proctor.x - pos.x, (proctor.y - pos.y) * 1.4, proctor.z - pos.z);

            if (dist < 9.2) {
                const penalty = isSabotage ? 35 : 45;
                student.score = Math.max(0, student.score - penalty);
                student.cheatingUntil = 0;
                student.statusEffect = 'caught';
                student.statusUntil = now + 4500;
                student.lastPopup = { text: `-${penalty} YAKALANDI!`, color: '#ef4444', id: now + Math.random() };
                proctor.catches += 1;
                anyoneCaught = true;

                // Hediye atan kişi yakalansa bile kamerada mutlaka görünür!
                scheduleCameraFocus({
                    isGift: true,
                    coins,
                    priority: 3,
                    type: 'caught',
                    userId: actorUser.userId,
                    seatIndex: sIdx,
                    targetSeatIndex: giverSeatIdx === sIdx ? receiverSeatIdx : giverSeatIdx,
                    title: `🚨 GÖZETMEN ${proctor.nickname} YAKALADI!`,
                    subtitle: `${student.nickname} (${coins} Jeton) gözetmen yanındayken yakalandı (-${penalty})!`,
                    color: '#ef4444',
                    baseDurationMs: 3000
                });
            }
        }
    }
    return anyoneCaught;
}

// Öğrenci Sınıfa Giriş (Uzun Yürüyüş & El Sallama Animasyonu ile)
function seatStudent(user, skipCamera = false) {
    const existingIdx = findStudentByUserId(user.userId);
    if (existingIdx !== -1) {
        touchUserActivity(user.userId);
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
    gameState.seats[chosenSeat] = {
        seatIndex: chosenSeat,
        userId: user.userId,
        nickname: user.nickname || user.userId,
        avatar: user.avatar || '',
        color: getRandomAvatarColor(user.userId),
        score: 10,
        joinedAt: now,
        lastActiveAt: now,
        studyingUntil: 0,
        cheatingUntil: 0,
        cheatTargetSeat: -1,
        statusEffect: null,
        statusUntil: 0,
        lastPopup: { text: '+10 Sınıfa Girdi', color: '#34d399', id: now }
    };

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
            baseDurationMs: 3800 // 3.8 saniye detaylı yürüyüş ve oturma çekimi
        });
    }
    return chosenSeat;
}

// Öğrenci Sınıftan Ayrılış (Ayağa Kalkma, El Sallama ve Kapıdan Çıkış Animasyonu)
function removeStudentFromHall(seatIdx, reasonText = 'Yayından ayrıldı') {
    const student = gameState.seats[seatIdx];
    if (!student) return;

    const now = Date.now();
    gameState.seats[seatIdx] = null;

    // Ayrılan karakteri 4.2 saniyelik çıkış animasyonu listesine ekle
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
        baseDurationMs: 3600 // 3.6 saniye ayrılış çekimi
    });
}

function promoteToProctor(user, coins) {
    const seatIdx = findStudentByUserId(user.userId);
    if (seatIdx !== -1) gameState.seats[seatIdx] = null;

    const existingProctor = gameState.proctors.find(p => p.userId === user.userId);
    if (existingProctor) {
        existingProctor.coins = Math.max(existingProctor.coins, coins);
        existingProctor.lastActiveAt = Date.now();
    } else {
        const startAngle = (Math.random() - 0.5) * 1.1;
        const startRadius = 14 + Math.random() * 10;
        const newProctor = {
            userId: user.userId,
            nickname: user.nickname || user.userId,
            avatar: user.avatar || '',
            color: getRandomAvatarColor(user.userId),
            coins,
            lastActiveAt: Date.now(),
            x: Math.sin(startAngle) * startRadius,
            y: 1.5,
            z: Math.cos(startAngle) * startRadius - 6,
            targetX: 0,
            targetZ: 6,
            catches: 0
        };

        if (coins > gameState.proctorRecord) {
            const retiredNames = gameState.proctors.map(p => p.nickname).join(', ');
            gameState.proctors = [newProctor];
            gameState.proctorRecord = coins;
            const extraMsg = retiredNames ? ` (${retiredNames} emekli oldu!)` : '';
            triggerBanner('YENİ GÖZETMEN ATANDI!', `${newProctor.nickname} (${coins} Jeton) amfide devriyeye çıktı${extraMsg}`, '#f59e0b');
        } else if (coins === gameState.proctorRecord && coins > 0) {
            gameState.proctors.push(newProctor);
            triggerBanner('GÖZETMEN SAYISI ARTTI!', `${newProctor.nickname} eşit jetonla (${coins}) devriyeye katıldı!`, '#fbbf24');
        } else if (coins === 0 && gameState.proctors.length === 0) {
            gameState.proctors = [newProctor];
            gameState.proctorRecord = 0;
            triggerBanner('TUR BİRİNCİSİ BAŞGÖZETMEN!', `${newProctor.nickname} en yüksek ortalamayla gözetmen oldu!`, '#38bdf8');
        }
    }

    // Gözetmen olan bağışçı mutlaka kamerada gösterilir!
    if (coins > 0) {
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'proctor',
            userId: user.userId,
            proctorUserId: user.userId,
            title: `👮 GÖZETMEN ${user.nickname} (${coins} Jeton)`,
            subtitle: `Amfi düzeni artık ${user.nickname} kontrolünde!`,
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

    let idx = findStudentByUserId(user.userId);
    if (idx === -1) {
        if (gameState.proctors.some(p => p.userId === user.userId)) {
            touchUserActivity(user.userId);
            return;
        }
        idx = seatStudent(user);
        if (idx === -1) return;
    }

    const student = gameState.seats[idx];
    student.lastActiveAt = now;

    if (rl.gained >= 15) return;
    const allowedGain = Math.min(count, 15 - rl.gained);
    rl.gained += allowedGain;
    likeRateLimiter.set(user.userId, rl);

    student.score += allowedGain;
    student.studyingUntil = now + 3000;
    student.lastPopup = { text: `+${allowedGain} Çalıştı`, color: '#4ade80', id: now + Math.random() };

    // Beğeni animasyonu da kamera boşta kaldığında öğrenciyi gösterir (kişi başı 15 sn kamera bekleme süresiyle)
    const lastCam = likeCamCooldown.get(user.userId) || 0;
    if (now - lastCam > 15000) {
        likeCamCooldown.set(user.userId, now);
        scheduleCameraFocus({
            isGift: false,
            coins: 0,
            priority: 1,
            type: 'study',
            userId: user.userId,
            seatIndex: idx,
            title: `📚 ${student.nickname} Ders Çalışıyor!`,
            subtitle: `Beğeni gönderdi (+${allowedGain} Puan • Toplam: ${student.score})`,
            color: '#4ade80',
            baseDurationMs: 2200
        });
    }
}

function handleGift(user, coins) {
    const now = Date.now();
    touchUserActivity(user.userId);

    // 1. Gözetmen Atama / Devir Kontrolü (100+ Jeton veya Mevcut Rekoru Geçme)
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
                    s.statusEffect = 'caught';
                    s.statusUntil = now + 4000;
                    s.lastPopup = { text: '-60 DİSİPLİN!', color: '#f87171', id: now + Math.random() };
                }
            });
            triggerBanner(
                isAmnesty ? 'KADER DEĞİŞTİ: GENEL AF!' : 'KADER DEĞİŞTİ: SIKI YÖNETİM!',
                `${user.nickname} (${coins} Jeton) tüm amfinin kaderini değiştirdi!`,
                isAmnesty ? '#10b981' : '#ef4444'
            );
        }
        return;
    }

    // Aktif gözetmen hediye atarsa kendi puanını/yakalamasını artırıp kamerada görünsün
    const activeProctor = gameState.proctors.find(p => p.userId === user.userId);
    if (activeProctor) {
        activeProctor.coins += coins;
        scheduleCameraFocus({
            isGift: true,
            coins,
            priority: 4,
            type: 'proctor',
            userId: user.userId,
            proctorUserId: user.userId,
            title: `👮 Gözetmen ${user.nickname} (+${coins} Jeton)`,
            subtitle: `Devriye gücünü artırdı (Toplam: ${activeProctor.coins} Jeton)`,
            color: '#fbbf24',
            baseDurationMs: 2800
        });
        return;
    }

    // Öğrenci değilse önce sıraya oturt (skipCamera=true çünkü hediye kamerası doğrudan açılacak!)
    let idx = findStudentByUserId(user.userId);
    if (idx === -1) {
        idx = seatStudent(user, true);
        if (idx === -1) return;
    }
    const actor = gameState.seats[idx];
    actor.lastActiveAt = now;
    const occupied = gameState.seats.filter(s => s && s.userId !== user.userId);

    // 50 - 99 Jeton: Cevap Anahtarı Ele Geçirme
    if (coins >= 50) {
        actor.score += 120;
        actor.statusEffect = 'answer_key';
        actor.statusUntil = now + 4500;
        actor.lastPopup = { text: '+120 CEVAP ANAHTARI!', color: '#fbbf24', id: now };
        const victims = occupied.sort(() => 0.5 - Math.random()).slice(0, 5);
        victims.forEach(v => {
            v.score = Math.max(0, v.score - 25);
            v.statusEffect = 'burned';
            v.statusUntil = now + 4500;
            v.lastPopup = { text: '-25 Kağıt Yandı!', color: '#f87171', id: now + Math.random() };
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

    // 10 - 49 Jeton: Gözetmene İspiyonlama
    if (coins >= 10) {
        const cheaters = occupied.filter(s => s.cheatingUntil > now);
        const target = cheaters.length > 0
            ? cheaters[Math.floor(Math.random() * cheaters.length)]
            : occupied.sort((a, b) => b.score - a.score)[0];

        actor.score += 25;
        actor.statusEffect = 'snitch';
        actor.statusUntil = now + 3500;
        actor.lastPopup = { text: '+25 İspiyon Ödülü', color: '#38bdf8', id: now };

        if (target) {
            const penalty = cheaters.length > 0 ? 45 : 25;
            target.score = Math.max(0, target.score - penalty);
            target.cheatingUntil = 0;
            target.statusEffect = 'caught';
            target.statusUntil = now + 4500;
            target.lastPopup = { text: `-${penalty} İSPİYONLANDI!`, color: '#ef4444', id: now };

            if (gameState.proctors.length > 0) {
                const p = gameState.proctors[0];
                const tPos = SEAT_LAYOUT[target.seatIndex];
                p.catches += 1;
                p.x = tPos.x;
                p.z = tPos.z;
            }
            scheduleCameraFocus({
                isGift: true,
                coins,
                priority: 3,
                type: 'snitch',
                userId: user.userId,
                seatIndex: idx,
                targetSeatIndex: target.seatIndex,
                title: `📣 ${actor.nickname} İspiyonladı (${coins} Jeton)!`,
                subtitle: `${target.nickname} gözetmene yakalandı (-${penalty} Puan)!`,
                color: '#38bdf8',
                baseDurationMs: 3000
            });
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

    // 5 - 9 Jeton: En Yakın Rakibe Yanlış Kopya Verme
    if (coins >= 5) {
        const victim = findNearestNeighborSeat(idx, actor.score);
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
                victim.statusEffect = 'wrong_cheat';
                victim.statusUntil = now + 4500;
                victim.lastPopup = { text: '-20 Yanlış Kopya!', color: '#fb7185', id: now };
                actor.score += 10;
                scheduleCameraFocus({
                    isGift: true,
                    coins,
                    priority: 2,
                    type: 'sabotage',
                    userId: user.userId,
                    seatIndex: idx,
                    targetSeatIndex: victim.seatIndex,
                    title: `😈 ${actor.nickname} Yanlış Kopya Attı (${coins} Jeton)!`,
                    subtitle: `Yanındaki ${victim.nickname} yanlış kopyayı aldı (-20 Puan)!`,
                    color: '#fb7185',
                    baseDurationMs: 2800
                });
            }
        } else {
            actor.score += 15;
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

    // 1 - 4 Jeton (Gül vb.): En Yakınındaki Kişiden Kopya Çekme
    const neighbor = findNearestNeighborSeat(idx, actor.score);
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
            subtitle: neighbor ? `Yanındaki ${neighbor.nickname} kağıdından çekti (+${gain})` : `Gizlice kopya çekti (+${gain})`,
            color: '#facc15',
            baseDurationMs: 2700
        });
    }
}

// Hızlı Döngü (200ms): Kamera Kuyruğu & Gözetmen Yakınlık Kontrolü
setInterval(() => {
    const now = Date.now();
    processFocusQueues();

    gameState.proctors.forEach(proctor => {
        gameState.seats.forEach(s => {
            if (!s || s.cheatingUntil <= now) return;
            const pos = SEAT_LAYOUT[s.seatIndex];
            const dist = Math.hypot(proctor.x - pos.x, (proctor.y - pos.y) * 1.4, proctor.z - pos.z);
            if (dist < 8.8) {
                const lost = Math.min(s.score, 45);
                s.score -= lost;
                s.cheatingUntil = 0;
                s.statusEffect = 'caught';
                s.statusUntil = now + 4500;
                s.lastPopup = { text: `-${lost} GÖZETMEN YAKALADI!`, color: '#ef4444', id: now + Math.random() };
                proctor.catches += 1;
                scheduleCameraFocus({
                    isGift: false,
                    coins: 0,
                    priority: 3,
                    type: 'caught',
                    userId: s.userId,
                    seatIndex: s.seatIndex,
                    title: `🚨 Gözetmen ${proctor.nickname} Yakaladı!`,
                    subtitle: `${s.nickname} devriye sırasında yakalandı (-${lost} Puan)!`,
                    color: '#ef4444',
                    baseDurationMs: 2800
                });
            }
        });
    });
}, 200);

// Ana Oyun Döngüsü (1 Saniye)
setInterval(() => {
    const now = Date.now();
    gameState.cheatPasses = gameState.cheatPasses.filter(cp => now - cp.createdAt < 3200);
    gameState.exitingStudents = gameState.exitingStudents.filter(ex => now - ex.startedAt < ex.durationMs);
    if (gameState.worldEffect && now > gameState.worldEffect.expiresAt) {
        gameState.worldEffect = null;
    }

    // 1. Yayından ayrılan / 3 dakikadır etkileşimsiz kalan öğrencileri animasyonla çıkar
    for (let i = 0; i < MAX_SEATS; i++) {
        const s = gameState.seats[i];
        if (s && (now - s.lastActiveAt > INACTIVITY_TIMEOUT_MS)) {
            removeStudentFromHall(i, 'Yayından ayrıldı');
        }
    }

    // 2. Uzun süre yayında olmayan pasif gözetmeni emekli et
    gameState.proctors = gameState.proctors.filter(p => (now - p.lastActiveAt) <= 240000);
    if (gameState.proctors.length === 0 && gameState.proctorRecord > 0) {
        gameState.proctorRecord = 0;
    }

    // 3. Gözetmenleri amfi içinde gezdir
    gameState.proctors.forEach(proctor => {
        if (Math.random() < 0.3) {
            const angle = (Math.random() - 0.5) * 1.45;
            const radius = 11 + Math.random() * 23;
            proctor.targetX = Math.sin(angle) * radius;
            proctor.targetZ = Math.cos(angle) * radius - 6;
        }
        proctor.x += (proctor.targetX - proctor.x) * 0.22;
        proctor.z += (proctor.targetZ - proctor.z) * 0.22;

        const distFromCenter = Math.hypot(proctor.x, proctor.z + 6);
        const approxTier = Math.max(0, Math.min(7, (distFromCenter - 11.5) / 3.5));
        proctor.y = 0.4 + approxTier * 0.72;
    });

    // 4. Tur Geri Sayımı
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
                s.statusEffect = null;
            }
        });
    }

    io.emit('state_update', {
        ...gameState,
        giftQueueLength: giftFocusQueue.length
    });
}, 1000);

// TikTok Canlı Yayın Bağlantısı
function connectToTikTok(username) {
    if (!username) return;
    const cleanUser = username.replace('@', '').trim();
    connectedUsername = cleanUser;

    if (tiktokConnection) {
        try { tiktokConnection.disconnect(); } catch (e) {}
    }

    connectionStatus = `@${cleanUser} yayınına bağlanılıyor...`;
    io.emit('status_update', { connectedUsername, connectionStatus });

    tiktokConnection = new WebcastPushConnection(cleanUser, {
        processInitialData: false,
        enableExtendedGiftInfo: true
    });

    const streakTracker = new Map();

    tiktokConnection.connect().then(() => {
        connectionStatus = `CANLI BAĞLI: @${cleanUser}`;
        io.emit('status_update', { connectedUsername, connectionStatus });
    }).catch(() => {
        connectionStatus = `Yayın bulunamadı veya kapalı (@${cleanUser})`;
        io.emit('status_update', { connectedUsername, connectionStatus });
    });

    tiktokConnection.on('roomUser', data => {
        if (data && Array.isArray(data.ranks)) {
            data.ranks.forEach(r => {
                if (r.user && r.user.uniqueId) {
                    touchUserActivity(r.user.uniqueId);
                }
            });
        }
    });

    tiktokConnection.on('chat', data => {
        const msg = (data.comment || '').trim().toLowerCase();
        const user = {
            userId: data.uniqueId,
            nickname: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        };
        touchUserActivity(user.userId);

        if (msg === 'katıl' || msg === 'katil' || msg === '1' || msg.includes('katıl')) {
            seatStudent(user);
            io.emit('state_update', { ...gameState, giftQueueLength: giftFocusQueue.length });
        }
    });

    tiktokConnection.on('like', data => {
        handleLike({
            userId: data.uniqueId,
            nickname: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        }, data.likeCount || 1);
    });

    tiktokConnection.on('gift', data => {
        const user = {
            userId: data.uniqueId,
            nickname: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        };
        const diamondValue = data.diamondCount || 1;
        const repeatCount = data.repeatCount || 1;
        const key = `${data.uniqueId}_${data.giftId}`;

        if (data.giftType === 1 && !data.repeatEnd) {
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

if (connectedUsername) connectToTikTok(connectedUsername);

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
                handleLike(seated[Math.floor(Math.random() * seated.length)], 5);
            }
        } else if (payload.type === 'gift') {
            const seated = gameState.seats.filter(Boolean);
            const actor = (payload.coins < 100 && seated.length > 0 && Math.random() > 0.35)
                ? seated[Math.floor(Math.random() * seated.length)]
                : testUser;
            handleGift(actor, payload.coins);
        } else if (payload.type === 'gift_storm') {
            // Aynı anda 4 farklı bağışçı test et (hiçbirinin atlanmadığını görmek için)
            const coinsList = [1, 5, 10, 50];
            coinsList.forEach((c, idx) => {
                const n = Math.floor(100 + Math.random() * 900);
                handleGift({ userId: `bagisci_${n}_${idx}`, nickname: `Bağışçı_${n}`, avatar: '' }, c);
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