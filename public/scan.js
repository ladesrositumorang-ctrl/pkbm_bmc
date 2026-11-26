(() => {
  const PREFIX = "PKBM:";
  const $ = (id) => document.getElementById(id);
  const app = $("scan-app");
  if (!app) return;

  const video = $("video");
  const frame = $("frame");
  const ctx = frame.getContext("2d", { willReadFrequently: true });
  const viewfinder = $("viewfinder");
  const vfText = $("vf-text");
  const camToggle = $("cam-toggle");
  const camSwitch = $("cam-switch");
  const sound = $("sound");
  const manualForm = $("manual-form");
  const manualInput = $("manual-input");
  const result = $("result");
  const total = Number(app.dataset.total) || 0;

  let stream = null;
  let devices = [];
  let deviceIndex = -1;
  let rafId = 0;
  let lastTick = 0;
  let busy = false;
  let audioCtx = null;
  const cooldown = new Map(); // payload -> waktu boleh dikirim lagi (ms)

  // ---------- Umpan balik ----------
  function beep(ok) {
    if (!sound.checked) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = ok ? [880, 1320] : [220];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const start = audioCtx.currentTime + i * 0.11;
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.16);
      });
    } catch (_) {}
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
  }

  function flash(kind) {
    viewfinder.dataset.flash = kind;
    setTimeout(() => delete viewfinder.dataset.flash, 700);
  }

  const ICONS = {
    checked_in: "i-ok",
    overridden: "i-ok",
    duplicate: "i-warn",
    invalid: "i-x",
    unknown: "i-x",
    inactive: "i-warn",
    network: "i-warn",
    idle: "i-scan",
  };

  function showResult(kind, title, sub, time) {
    result.dataset.kind = kind;
    result.querySelector(".result-icon use").setAttribute("href", "#" + ICONS[kind]);
    $("result-title").textContent = title;
    $("result-sub").textContent = sub;
    $("result-time").textContent = time || "";
  }

  function updateProgress(summary) {
    if (!summary) return;
    $("present-count").textContent = summary.hadir;
    $("present-bar").style.flex = String(summary.hadir);
    $("absent-bar").style.flex = String(Math.max((summary.total || total) - summary.hadir, 0));
  }

  function addRecent(member, time) {
    const list = $("recent-list");
    for (const li of list.querySelectorAll("li")) {
      if (li.querySelector("strong").textContent === member.name) li.remove();
    }
    const li = document.createElement("li");
    const avatar = document.createElement("span");
    avatar.className = "avatar avatar-sm";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = member.name.charAt(0);
    const info = document.createElement("span");
    info.className = "feed-name";
    const name = document.createElement("strong");
    name.textContent = member.name;
    const kind = document.createElement("small");
    kind.textContent = member.type === "tutor" ? "Tutor" : "Staf";
    info.append(name, kind);
    const t = document.createElement("time");
    t.className = "feed-time";
    t.textContent = time;
    li.append(avatar, info, t);
    list.prepend(li);
    while (list.children.length > 10) list.lastElementChild.remove();
    $("recent-empty").hidden = true;
  }

  // ---------- Kirim hasil pindai ke server ----------
  async function submit(raw, { force = false } = {}) {
    const payload = String(raw || "").trim();
    if (!payload) return;
    if (busy) return;
    const now = Date.now();
    if (!force && (cooldown.get(payload) || 0) > now) return;
    cooldown.set(payload, now + 5000);

    if (!payload.startsWith(PREFIX)) {
      beep(false);
      flash("bad");
      showResult("invalid", "Bukan kartu PKBM BMC", "QR ini tidak dikenali oleh sistem.");
      return;
    }

    busy = true;
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const data = await res.json().catch(() => ({
        ok: false,
        kind: "network",
        message: "Respons server tidak terbaca.",
      }));
      if (data.ok) {
        const fresh = data.kind === "checked_in" || data.kind === "overridden";
        beep(fresh);
        flash(fresh ? "ok" : "dup");
        showResult(
          data.kind,
          data.member.name,
          data.message,
          data.time ? data.time + " WIB" : "",
        );
        updateProgress(data.summary);
        if (fresh) addRecent(data.member, data.time);
      } else {
        beep(false);
        flash("bad");
        const title = data.member ? data.member.name : "Tidak bisa dicatat";
        showResult(data.kind || "invalid", title, data.message || "Terjadi kesalahan.");
      }
    } catch (_) {
      cooldown.delete(payload);
      beep(false);
      flash("bad");
      showResult("network", "Tidak terhubung ke server", "Periksa koneksi lalu pindai ulang.");
    } finally {
      busy = false;
    }
  }

  // ---------- Kamera ----------
  function setState(state, text) {
    viewfinder.dataset.state = state;
    if (text) vfText.textContent = text;
  }

  function stopCamera() {
    cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    camToggle.querySelector("span").textContent = "Aktifkan kamera";
    camSwitch.hidden = true;
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    const now = performance.now();
    if (now - lastTick < 110 || video.readyState < video.HAVE_CURRENT_DATA) return;
    lastTick = now;
    const scale = Math.min(1, 640 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (!w || !h) return;
    frame.width = w;
    frame.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
      inversionAttempts: "dontInvert",
    });
    if (code && code.data) submit(code.data);
  }

  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState(
        "error",
        "Kamera hanya bisa dipakai lewat https:// atau localhost. Gunakan pemindai USB di kolom bawah.",
      );
      return;
    }
    stopCamera();
    setState("loading", "Membuka kamera…");
    try {
      const video_ =
        deviceIndex >= 0 && devices[deviceIndex]
          ? { deviceId: { exact: devices[deviceIndex].deviceId } }
          : { facingMode: { ideal: "environment" } };
      stream = await navigator.mediaDevices.getUserMedia({ video: video_, audio: false });
      video.srcObject = stream;
      await video.play();
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput",
      );
      const activeId = stream.getVideoTracks()[0].getSettings().deviceId;
      deviceIndex = Math.max(
        devices.findIndex((d) => d.deviceId === activeId),
        0,
      );
      camSwitch.hidden = devices.length < 2;
      camToggle.querySelector("span").textContent = "Matikan kamera";
      setState("live");
      lastTick = 0;
      tick();
    } catch (err) {
      stopCamera();
      setState(
        "error",
        err && err.name === "NotAllowedError"
          ? "Izin kamera ditolak. Izinkan kamera di pengaturan browser, lalu coba lagi."
          : "Kamera tidak ditemukan atau sedang dipakai aplikasi lain.",
      );
    }
  }

  camToggle.addEventListener("click", () => {
    if (stream) {
      stopCamera();
      setState("idle", "Kamera belum aktif");
    } else {
      startCamera();
    }
  });
  camSwitch.addEventListener("click", () => {
    deviceIndex = (deviceIndex + 1) % devices.length;
    startCamera();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && stream) {
      stopCamera();
      setState("idle", "Kamera dimatikan saat halaman tidak terlihat");
    }
  });

  // ---------- Pemindai USB / input manual ----------
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  manualForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = manualInput.value;
    manualInput.value = "";
    submit(value, { force: true });
    if (finePointer) manualInput.focus();
  });
  if (finePointer) manualInput.focus();
})();
