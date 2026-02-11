import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Activity,
  User,
  DoorOpen,
  AlertTriangle,
  CheckCircle,
  History,
  Settings,
  ShieldAlert,
  Volume2,
  VolumeX
} from 'lucide-react';
import { SpeedInsights } from '@vercel/speed-insights/react';

// --- Firebase Configuration ---
const DATABASE_URL = import.meta.env.VITE_DATABASE_URL || "https://preserving-fall-detector-default-rtdb.firebaseio.com";
const DATABASE_SECRET = import.meta.env.VITE_DATABASE_SECRET || "";

// --- Alarm Sound System (Mobile-compatible) ---
// ใช้ทั้ง Web Audio API + HTML5 Audio fallback
// Pre-unlock audio ตั้งแต่ผู้ใช้ click/tap ครั้งแรก

class AlarmSound {
  constructor() {
    this.audioCtx = null;
    this.intervalId = null;
    this.isPlaying = false;
    this.isUnlocked = false;
    this.alarmBuffer = null;
    this.fallbackAudio = null;
    this._onUnlock = null;
  }

  // เรียกครั้งเดียวตอน mount — ผูก event listener สำหรับ unlock
  init(onUnlockCallback) {
    this._onUnlock = onUnlockCallback;

    // สร้าง fallback HTML5 Audio (ทำงานได้บน iOS/Android ที่บล็อก Web Audio)
    this._createFallbackAudio();

    // ดักจับ user interaction แรกเพื่อ unlock audio
    const unlockHandler = () => {
      this._unlock();
      // ลบ listener หลัง unlock สำเร็จ
      ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
        document.removeEventListener(evt, unlockHandler, { capture: true });
      });
    };

    ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
      document.addEventListener(evt, unlockHandler, { capture: true, passive: true });
    });
  }

  // Unlock AudioContext + pre-generate alarm buffer
  async _unlock() {
    try {
      // สร้าง AudioContext
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }

      // Resume ถ้า suspended (จำเป็นสำหรับ mobile)
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // เล่นเสียงเงียบเพื่อ unlock (iOS ต้องการ)
      const silentOsc = this.audioCtx.createOscillator();
      const silentGain = this.audioCtx.createGain();
      silentGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      silentOsc.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
      silentOsc.start();
      silentOsc.stop(this.audioCtx.currentTime + 0.01);

      // Pre-generate alarm buffer เพื่อให้เล่นได้ทันที
      this._generateAlarmBuffer();

      // Unlock fallback audio ด้วย
      if (this.fallbackAudio) {
        try {
          this.fallbackAudio.volume = 0;
          await this.fallbackAudio.play();
          this.fallbackAudio.pause();
          this.fallbackAudio.currentTime = 0;
          this.fallbackAudio.volume = 1;
        } catch (_e) { /* ไม่เป็นไร */ }
      }

      this.isUnlocked = true;
      console.log('🔓 Audio unlocked — alarm ready');

      if (this._onUnlock) {
        this._onUnlock(true);
      }
    } catch (e) {
      console.error('Audio unlock failed:', e);
    }
  }

  // สร้าง alarm WAV buffer ล่วงหน้า (เล่นได้ทันทีไม่ต้อง synthesize)
  _generateAlarmBuffer() {
    if (!this.audioCtx) return;

    const sampleRate = this.audioCtx.sampleRate;
    const duration = 1.8; // ความยาว 1 รอบ
    const length = sampleRate * duration;
    const buffer = this.audioCtx.createBuffer(1, length, sampleRate);
    const channel = buffer.getChannelData(0);

    // สร้างเสียง siren: สลับ 880Hz กับ 660Hz ทุก 0.2 วินาที
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const cyclePos = t % 0.4; // 0.4s per high-low cycle
      const freq = cyclePos < 0.2 ? 880 : 660;

      // Square wave (ดังกว่า sine wave)
      const wave = Math.sin(2 * Math.PI * freq * t) > 0 ? 0.7 : -0.7;

      // Envelope ต่อ beep (ตัด click)
      const beepPos = t % 0.2;
      let envelope = 1;
      if (beepPos < 0.005) envelope = beepPos / 0.005; // attack 5ms
      if (beepPos > 0.18) envelope = (0.2 - beepPos) / 0.02; // release 20ms

      // Pause ช่วงท้าย
      if (t > 1.6) envelope *= (duration - t) / 0.2;

      channel[i] = wave * envelope;
    }

    this.alarmBuffer = buffer;
  }

  // สร้าง HTML5 Audio fallback (ใช้ data URI — ไม่ต้องโหลดไฟล์)
  _createFallbackAudio() {
    try {
      // สร้าง WAV ง่ายๆ แบบ PCM
      const sampleRate = 22050;
      const duration = 1.8;
      const numSamples = Math.floor(sampleRate * duration);
      const dataSize = numSamples * 2; // 16-bit
      const headerSize = 44;
      const buffer = new ArrayBuffer(headerSize + dataSize);
      const view = new DataView(buffer);

      // WAV header
      const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, dataSize, true);

      // Generate alarm tones
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const cyclePos = t % 0.4;
        const freq = cyclePos < 0.2 ? 880 : 660;
        const wave = Math.sin(2 * Math.PI * freq * t) > 0 ? 0.6 : -0.6;

        let envelope = 1;
        const beepPos = t % 0.2;
        if (beepPos < 0.005) envelope = beepPos / 0.005;
        if (beepPos > 0.18) envelope = (0.2 - beepPos) / 0.02;
        if (t > 1.6) envelope *= (duration - t) / 0.2;

        const sample = Math.max(-1, Math.min(1, wave * envelope));
        view.setInt16(headerSize + i * 2, sample * 32767, true);
      }

      // แปลงเป็น base64 data URI
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const dataUri = 'data:audio/wav;base64,' + btoa(binary);

      this.fallbackAudio = new Audio(dataUri);
      this.fallbackAudio.loop = true;
      this.fallbackAudio.preload = 'auto';
    } catch (e) {
      console.error('Fallback audio creation failed:', e);
    }
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    console.log('🔊 Alarm playing...');

    // วิธี 1: Web Audio API (เสียงดีกว่า, เล่นทันที)
    if (this.audioCtx && this.alarmBuffer && this.isUnlocked) {
      this._playWithWebAudio();
    }
    // วิธี 2: HTML5 Audio fallback (สำหรับ mobile ที่ Web Audio ไม่ทำงาน)
    else if (this.fallbackAudio) {
      this._playWithFallback();
    }
  }

  _playWithWebAudio() {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const playOnce = () => {
      if (!this.isPlaying || !this.audioCtx || !this.alarmBuffer) return;
      const source = this.audioCtx.createBufferSource();
      source.buffer = this.alarmBuffer;
      source.connect(this.audioCtx.destination);
      source.start(0);
    };

    playOnce();
    this.intervalId = setInterval(playOnce, 2000);
  }

  _playWithFallback() {
    if (!this.fallbackAudio) return;
    try {
      this.fallbackAudio.currentTime = 0;
      this.fallbackAudio.volume = 1;
      const p = this.fallbackAudio.play();
      if (p) p.catch(() => { }); // ignore autoplay errors
    } catch (_e) { /* ignore */ }
  }

  stop() {
    this.isPlaying = false;

    // หยุด Web Audio
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // หยุด fallback audio
    if (this.fallbackAudio) {
      try {
        this.fallbackAudio.pause();
        this.fallbackAudio.currentTime = 0;
      } catch (_e) { /* ignore */ }
    }
  }

  dispose() {
    this.stop();
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => { });
      this.audioCtx = null;
    }
    this.fallbackAudio = null;
    this.alarmBuffer = null;
  }
}

const App = () => {
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeAlert, setActiveAlert] = useState(false);
  const [lastAlert, setLastAlert] = useState(null);
  const [error, setError] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [alarmAcknowledged, setAlarmAcknowledged] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const eventSourceRef = useRef(null);
  const alarmRef = useRef(null);

  // Initialize alarm instance — unlock audio ตั้งแต่ user interact ครั้งแรก
  useEffect(() => {
    const alarm = new AlarmSound();
    alarmRef.current = alarm;
    alarm.init((unlocked) => setAudioReady(unlocked));
    return () => {
      if (alarmRef.current) {
        alarmRef.current.dispose();
      }
    };
  }, []);

  // Helper: Deep merge สำหรับ partial updates (patch events)
  const deepMerge = useCallback((target, path, value) => {
    const result = JSON.parse(JSON.stringify(target)); // deep clone
    const keys = path.split('/').filter(k => k !== '');

    if (keys.length === 0) {
      // Root path — replace entirely
      return value || {};
    }

    let current = result;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }

    const lastKey = keys[keys.length - 1];
    if (value === null) {
      delete current[lastKey];
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      current[lastKey] = { ...(current[lastKey] || {}), ...value };
    } else {
      current[lastKey] = value;
    }

    return result;
  }, []);

  // Fetch data ผ่าน REST API (ใช้กับ initial load และ fallback)
  const fetchFullData = useCallback(async () => {
    try {
      const url = `${DATABASE_URL}/hospital_system/wards/ward_A.json?auth=${DATABASE_SECRET}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data) {
        setRooms(data);
        processAlerts(data);
      } else {
        setRooms({});
        setActiveAlert(false);
      }

      setConnected(true);
      setError(null);
      setLoading(false);
    } catch (err) {
      console.error("Fetch Error:", err);
      setError(err.message);
      setLoading(false);
    }
  }, []);

  // Real-time Data Fetching ผ่าน Firebase REST API (SSE - Server-Sent Events)
  useEffect(() => {
    let pollingInterval = null;
    let reconnectTimeout = null;
    let isCancelled = false;

    const connectSSE = () => {
      if (isCancelled) return;

      // สร้าง URL สำหรับ streaming data ผ่าน REST API
      const streamUrl = `${DATABASE_URL}/hospital_system/wards/ward_A.json?auth=${DATABASE_SECRET}`;

      const eventSource = new EventSource(streamUrl);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log("✅ SSE Connected — Real-time updates active");
        setConnected(true);
        setError(null);

        // หยุด polling ถ้า SSE เชื่อมต่อสำเร็จ
        if (pollingInterval) {
          clearInterval(pollingInterval);
          pollingInterval = null;
        }
      };

      // ★ Firebase SSE ส่ง named events "put" และ "patch" ไม่ใช่ "message" ★
      // นี่คือสาเหตุที่ onmessage ไม่เคยทำงาน!

      // PUT event = Full data replacement ที่ path นั้น
      eventSource.addEventListener('put', (event) => {
        try {
          const { path, data } = JSON.parse(event.data);
          console.log(`📥 PUT event at ${path}`, data);

          if (path === '/') {
            // Full data update (ข้อมูลทั้งหมดของ ward_A)
            const newData = data || {};
            setRooms(newData);
            if (data) {
              processAlerts(newData);
            } else {
              setActiveAlert(false);
            }
          } else {
            // Partial path update (เช่น /room_101/live_status/fall_detected)
            setRooms(prevRooms => {
              const updated = deepMerge(prevRooms, path, data);
              processAlerts(updated);
              return updated;
            });
          }

          setLoading(false);
          setConnected(true);
        } catch (err) {
          console.error("SSE PUT parse error:", err);
        }
      });

      // PATCH event = Partial merge ที่ path นั้น
      eventSource.addEventListener('patch', (event) => {
        try {
          const { path, data } = JSON.parse(event.data);
          console.log(`📥 PATCH event at ${path}`, data);

          setRooms(prevRooms => {
            const updated = deepMerge(prevRooms, path, data);
            processAlerts(updated);
            return updated;
          });

          setConnected(true);
        } catch (err) {
          console.error("SSE PATCH parse error:", err);
        }
      });

      // Keep-alive event (Firebase ส่งมาเพื่อรักษาการเชื่อมต่อ)
      eventSource.addEventListener('keep-alive', () => {
        setConnected(true);
      });

      // Cancel event (Firebase ปิดการเชื่อมต่อ)
      eventSource.addEventListener('cancel', () => {
        console.warn("⚠️ SSE connection cancelled by server");
        setConnected(false);
        eventSource.close();
        startPolling();
      });

      // Auth revoked event
      eventSource.addEventListener('auth_revoked', () => {
        console.warn("⚠️ SSE auth revoked — check DATABASE_SECRET");
        setError("การยืนยันตัวตนถูกยกเลิก — ตรวจสอบ DATABASE_SECRET");
        setConnected(false);
        eventSource.close();
      });

      eventSource.onerror = (err) => {
        console.error("❌ SSE Error:", err);
        setConnected(false);

        // EventSource จะ auto-reconnect ถ้า readyState != CLOSED
        if (eventSource.readyState === EventSource.CLOSED) {
          console.log("🔄 SSE closed, switching to polling + will retry SSE...");
          setError("SSE ถูกตัดการเชื่อมต่อ — ใช้ polling ชั่วคราว");
          startPolling();

          // ลอง reconnect SSE อีกครั้งใน 10 วินาที
          reconnectTimeout = setTimeout(() => {
            console.log("🔄 Retrying SSE connection...");
            if (pollingInterval) {
              clearInterval(pollingInterval);
              pollingInterval = null;
            }
            connectSSE();
          }, 10000);
        }
        // ถ้า readyState == CONNECTING, EventSource จะ auto-retry เอง
      };
    };

    // Polling fallback (ทุก 2 วินาที)
    const startPolling = () => {
      if (pollingInterval) return; // ไม่ซ้ำซ้อน
      console.log("⏱️ Starting polling fallback (every 2s)");
      fetchFullData(); // Fetch ทันที
      pollingInterval = setInterval(fetchFullData, 2000);
    };

    // เริ่มต้น: fetch ข้อมูลทันที แล้วเปิด SSE
    fetchFullData();
    connectSSE();

    // Cleanup
    return () => {
      isCancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, [fetchFullData, deepMerge]);

  // ตรวจสอบว่ามีห้องไหนล้มหรือไม่
  const processAlerts = (data) => {
    let emergency = false;
    Object.keys(data).forEach(roomKey => {
      if (data[roomKey].live_status?.fall_detected) {
        emergency = true;
        setLastAlert({
          room: roomKey.replace('room_', ''),
          patient: data[roomKey].patient_info?.name || 'Unknown',
          time: new Date().toLocaleTimeString('th-TH')
        });
      }
    });
    setActiveAlert(emergency);
  };

  // ระบบแจ้งเตือนเสียงเมื่อมีการล้ม
  useEffect(() => {
    if (activeAlert && !isMuted && !alarmAcknowledged) {
      console.log("!!! EMERGENCY ALERT — ALARM SOUNDING !!!");
      alarmRef.current?.play();
    } else {
      alarmRef.current?.stop();
    }
  }, [activeAlert, isMuted, alarmAcknowledged]);

  // Reset acknowledged state when alert clears
  useEffect(() => {
    if (!activeAlert) {
      setAlarmAcknowledged(false);
    }
  }, [activeAlert]);

  // รับทราบเหตุ — หยุดเสียงเตือน
  const handleAcknowledge = useCallback(() => {
    setAlarmAcknowledged(true);
    alarmRef.current?.stop();
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      if (!prev) {
        alarmRef.current?.stop();
      }
      return !prev;
    });
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-content">
          <Activity className="loading-spinner" />
          <p className="loading-text">กำลังเชื่อมต่อระบบศูนย์พยาบาล...</p>
          <p style={{ color: 'var(--slate-500)', marginTop: '0.5rem', fontSize: '0.875rem' }}>
            Connecting to Nurse Station Monitor
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`main-container ${activeAlert ? 'main-container--alert' : 'main-container--normal'}`}>
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className={`header-icon ${activeAlert ? 'header-icon--alert' : 'header-icon--normal'}`}>
            <ShieldAlert size={32} className="text-white" />
          </div>
          <div>
            <h1 className="header-title">ระบบเฝ้าระวังการล้ม (Ward A)</h1>
            <p className="header-status">
              <span className={`status-dot ${connected ? 'status-dot--online' : 'status-dot--offline'}`}></span>
              สถานะ: {connected ? 'เชื่อมต่อระบบแล้ว' : 'ไม่สามารถเชื่อมต่อได้'}
            </p>
          </div>
        </div>

        <div className="header-right">
          <div className="date-display">
            {new Date().toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
          <button
            className={`settings-btn ${isMuted ? 'muted' : ''} ${audioReady ? 'audio-ready' : 'audio-locked'}`}
            id="mute-toggle"
            aria-label={isMuted ? 'Unmute alarm' : 'Mute alarm'}
            onClick={toggleMute}
            title={
              !audioReady
                ? 'แตะเพื่อเปิดใช้เสียงเตือน'
                : isMuted
                  ? 'เปิดเสียงเตือน'
                  : 'ปิดเสียงเตือน'
            }
          >
            {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            {!audioReady && <span className="audio-badge">!</span>}
          </button>
          <button className="settings-btn" id="settings-button" aria-label="Settings">
            <Settings size={20} />
          </button>
        </div>
      </header>

      {/* Audio unlock prompt (สำหรับ Mobile) */}
      {!audioReady && (
        <div
          className="audio-unlock-banner"
          onClick={() => alarmRef.current?._unlock()}
          role="button"
          tabIndex={0}
        >
          <Volume2 size={18} />
          <span>แตะที่นี่เพื่อเปิดใช้เสียงแจ้งเตือน</span>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div style={{ maxWidth: '80rem', margin: '0 auto 1rem', padding: '0.75rem 1rem', background: 'rgba(234, 179, 8, 0.15)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: '0.75rem', color: '#facc15', fontSize: '0.875rem' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Emergency Banner */}
      {activeAlert && (
        <div className="emergency-banner">
          <div className="emergency-banner-inner">
            <div className="emergency-info">
              <AlertTriangle size={40} />
              <div>
                <h2 className="emergency-title">ตรวจพบการล้ม!</h2>
                <p className="emergency-detail">ห้อง {lastAlert?.room}: {lastAlert?.patient} (เมื่อเวลา {lastAlert?.time})</p>
              </div>
            </div>
            <button className="emergency-ack-btn" id="acknowledge-alert" onClick={handleAcknowledge}>
              {alarmAcknowledged ? '✓ รับทราบแล้ว' : '🔔 รับทราบเหตุ'}
            </button>
          </div>
        </div>
      )}

      {/* Main Grid */}
      <main className="room-grid">
        {Object.entries(rooms).length > 0 ? (
          Object.entries(rooms).map(([id, data]) => {
            const roomNum = id.replace('room_', '');
            const isFalled = data.live_status?.fall_detected;
            const isOnline = data.live_status?.online;

            return (
              <div
                key={id}
                className={`room-card ${isFalled ? 'room-card--emergency' : 'room-card--normal'}`}
                id={`room-card-${roomNum}`}
              >
                {/* Header Card */}
                <div className="card-header">
                  <div className="card-header-top">
                    <div className="card-room-info">
                      <div className={`card-room-icon ${isFalled ? 'card-room-icon--emergency' : 'card-room-icon--normal'}`}>
                        <DoorOpen className="text-white" size={24} />
                      </div>
                      <div>
                        <h3 className="card-room-name">ห้อง {roomNum}</h3>
                        <span className={`card-online-status ${isOnline ? 'card-online-status--online' : 'card-online-status--offline'}`}>
                          {isOnline ? '● Online' : '○ Offline'}
                        </span>
                      </div>
                    </div>
                    <div className={`status-badge ${isFalled ? 'status-badge--emergency' : 'status-badge--normal'}`}>
                      {isFalled ? 'Emergency' : 'Normal'}
                    </div>
                  </div>

                  <div className="card-details">
                    <div className="detail-row">
                      <div className="detail-icon">
                        <User size={18} />
                      </div>
                      <div>
                        <p className="detail-label">ชื่อผู้ป่วย</p>
                        <p className="detail-value">{data.patient_info?.name || 'ไม่ระบุชื่อ'}</p>
                      </div>
                    </div>

                    <div className="detail-row">
                      <div className="detail-icon">
                        <Activity size={18} />
                      </div>
                      <div className="flex-1">
                        <p className="detail-label">สถานะล่าสุด</p>
                        <div>
                          {isFalled ? (
                            <span className="status-text--danger">
                              <AlertTriangle size={14} /> ตรวจพบแรงกระแทก
                            </span>
                          ) : (
                            <span className="status-text--safe">
                              <CheckCircle size={14} /> ปลอดภัย
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action Area */}
                <div className="card-action">
                  <button
                    className={`action-btn ${isFalled ? 'action-btn--emergency' : 'action-btn--normal'}`}
                    id={`room-action-${roomNum}`}
                  >
                    {isFalled ? 'ตอบสนองทันที' : 'ดูรายละเอียด'}
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="empty-state">
            <p>ไม่พบข้อมูลห้องผู้ป่วยในระบบ</p>
            <p>ตรวจสอบการเชื่อมต่อ Firebase และข้อมูลใน /hospital_system/wards/ward_A</p>
          </div>
        )}

        {/* History Card */}
        <div className="history-card" id="view-history">
          <div className="history-icon-wrapper">
            <History size={24} />
          </div>
          <span className="history-label">ดูประวัติการแจ้งเตือนทั้งหมด</span>
        </div>
      </main>

      {/* Footer / Status Bar */}
      <footer className="footer">
        <p>© 2025 Nurse Station Monitor System • PIM IoT Project</p>
        <div className="footer-legend">
          <div className="legend-item">
            <span className="legend-dot legend-dot--emergency"></span> Emergency
          </div>
          <div className="legend-item">
            <span className="legend-dot legend-dot--normal"></span> Normal
          </div>
          <div className="legend-item">
            <span className="legend-dot legend-dot--offline"></span> Offline
          </div>
        </div>
      </footer>
      <SpeedInsights />
    </div>
  );
};

export default App;
