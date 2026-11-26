const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const QRCode = require("qrcode");
const db = require("./db");
const { formatTitleCase } = require("./name-format");

const STATUSES = ["hadir", "izin", "sakit", "alpa"];
const STATUS_LABELS = {
  hadir: "Hadir",
  izin: "Izin",
  sakit: "Sakit",
  alpa: "Alpa",
};
const STATUS_COLORS = {
  hadir: "#177a55",
  izin: "#e0a825",
  sakit: "#7b5cc4",
  alpa: "#c93a33",
};
// Isi QR = prefix + token acak milik anggota. Prefix membuat pemindai bisa menolak QR asing.
const QR_PREFIX = "PKBM:";
const TYPES = ["tutor", "staf"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "4kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
// Pustaka pembaca QR dilayani dari node_modules agar tidak perlu internet/CDN.
app.get("/vendor/jsqr.js", (req, res) =>
  res.sendFile(require.resolve("jsqr/dist/jsQR.js")),
);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "ganti-secret-ini-di-produksi",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 8 * 3600 * 1000 },
  }),
);
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.formatTitleCase = formatTitleCase;
  res.locals.hhmm = hhmm;
  res.locals.longDate = longDate;
  res.locals.rangeLabel = rangeLabel;
  next();
});

const requireLogin = (req, res, next) =>
  req.session.user ? next() : res.redirect("/login");
const requireAdmin = (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "admin")
    return res.status(403).send("Akses ditolak: khusus admin.");
  next();
};

const requireAdminApi = (req, res, next) => {
  if (!req.session.user)
    return res
      .status(401)
      .json({ ok: false, message: "Sesi berakhir. Muat ulang halaman lalu masuk lagi." });
  if (req.session.user.role !== "admin")
    return res
      .status(403)
      .json({ ok: false, message: "Akses ditolak: khusus admin." });
  next();
};

const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
const validDate = (d) => (DATE_RE.test(d || "") ? d : today());
const iso = (d) => d.toISOString().slice(0, 10);
const nowJakarta = () => {
  const d = new Date();
  return {
    date: d.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }),
    time: d.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Jakarta",
      hourCycle: "h23",
    }),
  };
};
const shiftDate = (dateStr, days) => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const longDate = (dateStr) =>
  new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateStr + "T00:00:00Z"));
const rangeLabel = (from, to) => {
  if (from === to) return longDate(from);
  const fmt = (d, o) =>
    new Intl.DateTimeFormat("id-ID", { ...o, timeZone: "UTC" }).format(
      new Date(d + "T00:00:00Z"),
    );
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth
    ? `${fmt(from, { day: "numeric" })}–${fmt(to, { day: "numeric", month: "long", year: "numeric" })}`
    : `${fmt(from, { day: "numeric", month: "short", year: "numeric" })} – ${fmt(to, { day: "numeric", month: "short", year: "numeric" })}`;
};
const qrPayload = (token) => QR_PREFIX + token;
const qrSvg = (token, margin = 2) =>
  QRCode.toString(qrPayload(token), {
    type: "svg",
    errorCorrectionLevel: "M",
    margin,
  });
const hhmm = (time) => (time ? time.slice(0, 5) : null);

function getRange(period, dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (period === "mingguan") {
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Senin
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return [iso(start), iso(end)];
  }
  if (period === "bulanan") {
    return [
      iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))),
      iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))),
    ];
  }
  return [dateStr, dateStr];
}

function validMonth(value, fallback) {
  if (!/^\d{4}-\d{2}$/.test(value || "")) return fallback;
  const [year, month] = value.split("-").map(Number);
  return year >= 1000 && month >= 1 && month <= 12 ? value : fallback;
}

function validYear(value, fallback) {
  return /^\d{4}$/.test(value || "") && Number(value) >= 1000
    ? value
    : fallback;
}

function selectedStatuses(value) {
  const requested = Array.isArray(value) ? value : [value];
  const selected = STATUSES.filter((status) => requested.includes(status));
  return selected.length ? selected : STATUSES;
}

function buildAttendanceChart(mode, month, year, statuses) {
  let buckets;
  let rows;
  if (mode === "harian") {
    const [chartYear, chartMonth] = month.split("-").map(Number);
    const lastDate = new Date(Date.UTC(chartYear, chartMonth, 0)).getUTCDate();
    const from = `${month}-01`;
    const to = `${month}-${String(lastDate).padStart(2, "0")}`;
    buckets = Array.from({ length: lastDate }, (_, index) => ({
      key: `${month}-${String(index + 1).padStart(2, "0")}`,
      label: String(index + 1),
      counts: Object.fromEntries(STATUSES.map((status) => [status, 0])),
    }));
    rows = db
      .prepare(
        `SELECT a.date AS period, a.status, COUNT(*) AS count
      FROM attendance a JOIN members m ON m.id = a.member_id
      WHERE a.date BETWEEN ? AND ? AND m.active = 1
      GROUP BY a.date, a.status`,
      )
      .all(from, to);
  } else {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    buckets = Array.from({ length: 12 }, (_, index) => {
      const monthDate = new Date(Date.UTC(Number(year), index, 1));
      return {
        key: `${year}-${String(index + 1).padStart(2, "0")}`,
        label: new Intl.DateTimeFormat("id-ID", {
          month: "short",
          timeZone: "UTC",
        }).format(monthDate),
        counts: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      };
    });
    rows = db
      .prepare(
        `SELECT strftime('%Y-%m', a.date) AS period, a.status, COUNT(*) AS count
      FROM attendance a JOIN members m ON m.id = a.member_id
      WHERE a.date BETWEEN ? AND ? AND m.active = 1
      GROUP BY strftime('%Y-%m', a.date), a.status`,
      )
      .all(from, to);
  }

  const bucketByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  rows.forEach((row) => {
    const bucket = bucketByKey.get(row.period);
    if (bucket && STATUSES.includes(row.status))
      bucket.counts[row.status] = row.count;
  });

  const largestValue = Math.max(
    0,
    ...buckets.flatMap((bucket) =>
      statuses.map((status) => bucket.counts[status]),
    ),
  );
  const paddedMax = Math.max(largestValue + 1, Math.ceil(largestValue * 1.12));
  const step = Math.max(1, Math.ceil(paddedMax / 5));
  const maxValue = Math.ceil(paddedMax / step) * step;
  const width = 960;
  const height = 304;
  const left = 54;
  const right = 24;
  const top = 24;
  const plotHeight = 236;
  const plotWidth = width - left - right;
  const baseline = top + plotHeight;
  const slotWidth = plotWidth / buckets.length;
  const barWidth = Math.min(34, slotWidth * 0.66);
  const columns = buckets.map((bucket, index) => {
    const visibleStatuses = statuses.filter(
      (status) => bucket.counts[status] > 0,
    );
    const topStatus = visibleStatuses[visibleStatuses.length - 1];
    let stacked = 0;
    const segments = [];

    for (const status of statuses) {
      const count = bucket.counts[status];
      if (!count) continue;
      const segmentHeight = (count / maxValue) * plotHeight;
      const x = left + index * slotWidth + (slotWidth - barWidth) / 2;
      const y = baseline - stacked - segmentHeight;
      const radius =
        status === topStatus ? Math.min(6, barWidth / 2, segmentHeight / 2) : 0;
      const rightEdge = x + barWidth;
      const bottomEdge = y + segmentHeight;
      const path =
        radius > 0
          ? `M ${x} ${bottomEdge} L ${x} ${y + radius} Q ${x} ${y} ${x + radius} ${y} L ${rightEdge - radius} ${y} Q ${rightEdge} ${y} ${rightEdge} ${y + radius} L ${rightEdge} ${bottomEdge} Z`
          : `M ${x} ${y} H ${rightEdge} V ${bottomEdge} H ${x} Z`;
      segments.push({ path, color: STATUS_COLORS[status] });
      stacked += segmentHeight;
    }

    const tooltipDate = new Date(
      `${mode === "harian" ? bucket.key : `${bucket.key}-01`}T00:00:00Z`,
    );
    const tooltipTitle = new Intl.DateTimeFormat(
      "id-ID",
      mode === "harian"
        ? { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }
        : { month: "long", year: "numeric", timeZone: "UTC" },
    ).format(tooltipDate);
    const tooltipStatuses = statuses.map((status) => ({
      value: status,
      label: STATUS_LABELS[status],
      color: STATUS_COLORS[status],
      count: bucket.counts[status],
    }));
    const total = STATUSES.reduce(
      (sum, status) => sum + bucket.counts[status],
      0,
    );

    return {
      key: bucket.key,
      label: bucket.label,
      x: left + index * slotWidth,
      center: left + (index + 0.5) * slotWidth,
      width: slotWidth,
      segments,
      tooltipTitle,
      tooltipStatuses,
      total,
      ariaLabel: `${tooltipTitle}. ${tooltipStatuses
        .map(({ label, count }) => `${label}: ${count}`)
        .join(", ")}. Total seluruh status: ${total}.`,
    };
  });

  const ticks = [];
  for (let value = 0; value <= maxValue; value += step) {
    ticks.push({ value, y: baseline - (value / maxValue) * plotHeight });
  }

  return {
    buckets,
    columns,
    ticks,
    hasData: buckets.some((bucket) =>
      statuses.some((status) => bucket.counts[status] > 0),
    ),
    hasAnyData: buckets.some((bucket) =>
      STATUSES.some((status) => bucket.counts[status] > 0),
    ),
    mode,
    month,
    year,
    statuses,
    width,
    height,
    left,
    right,
    top,
    plotWidth,
    plotHeight,
    baseline,
    maxValue,
  };
}

// ---------- Auth ----------
app.get("/login", (req, res) => res.render("login", { error: null }));
app.post("/login", (req, res) => {
  const u = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get((req.body.username || "").trim());
  if (!u || !bcrypt.compareSync(req.body.password || "", u.password_hash)) {
    return res
      .status(401)
      .render("login", { error: "Username atau password salah." });
  }
  req.session.regenerate(() => {
    req.session.user = { id: u.id, name: u.name, role: u.role };
    res.redirect("/");
  });
});
app.post("/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/login")),
);

// ---------- Dashboard ----------
app.get("/", requireLogin, (req, res) => {
  const date = today();
  const total = db
    .prepare("SELECT COUNT(*) c FROM members WHERE active = 1")
    .get().c;
  const rows = db
    .prepare(
      `SELECT a.status, COUNT(*) c FROM attendance a
    JOIN members m ON m.id = a.member_id WHERE a.date = ? AND m.active = 1 GROUP BY a.status`,
    )
    .all(date);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  rows.forEach((r) => (counts[r.status] = r.c));
  const recorded = Object.values(counts).reduce((a, b) => a + b, 0);
  const mode = ["harian", "bulanan"].includes(req.query.mode)
    ? req.query.mode
    : "harian";
  const month = validMonth(req.query.month, date.slice(0, 7));
  const year = validYear(req.query.year, date.slice(0, 4));
  const statuses = selectedStatuses(req.query.status);
  const chart = buildAttendanceChart(mode, month, year, statuses);
  const chartModeUrls = {};
  for (const chartMode of ["harian", "bulanan"]) {
    const params = new URLSearchParams({ mode: chartMode, month, year });
    statuses.forEach((status) => params.append("status", status));
    chartModeUrls[chartMode] = `/?${params.toString()}`;
  }
  const chartStatusOptions = STATUSES.map((status) => ({
    value: status,
    label: STATUS_LABELS[status],
    checked: statuses.includes(status),
    color: STATUS_COLORS[status],
  }));
  const recent = db
    .prepare(
      `SELECT m.name, m.type, a.check_in_time, a.source
    FROM attendance a JOIN members m ON m.id = a.member_id
    WHERE a.date = ? AND m.active = 1 AND a.check_in_time IS NOT NULL
    ORDER BY a.check_in_time DESC LIMIT 6`,
    )
    .all(date);
  const chartPeriodLabel =
    mode === "harian"
      ? new Intl.DateTimeFormat("id-ID", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${month}-01T00:00:00Z`))
      : year;
  res.render("dashboard", {
    date,
    dateLabel: longDate(date),
    total,
    counts,
    recorded,
    pending: total - recorded,
    recent,
    STATUSES,
    STATUS_LABELS,
    STATUS_COLORS,
    chart,
    chartPeriodLabel,
    chartModeUrls,
    chartStatusOptions,
  });
});

// ---------- Data anggota ----------
function renderMembers(res, extra = {}) {
  const members = db
    .prepare("SELECT * FROM members ORDER BY active DESC, type, name")
    .all();
  res.render("members", { members, edit: null, error: null, TYPES, ...extra });
}
app.get("/members", requireLogin, (req, res) => {
  const edit = req.query.edit
    ? db.prepare("SELECT * FROM members WHERE id = ?").get(req.query.edit)
    : null;
  renderMembers(res, { edit });
});
app.post("/members", requireAdmin, (req, res) => {
  const { id, code, name, type, class_name } = req.body;
  const active = req.body.active ? 1 : 0;
  if (!code?.trim() || !name?.trim() || !TYPES.includes(type)) {
    return renderMembers(res, { error: "Kode, nama, dan jenis wajib diisi." });
  }
  try {
    if (id) {
      db.prepare(
        "UPDATE members SET code=?, name=?, type=?, class_name=?, active=? WHERE id=?",
      ).run(
        code.trim(),
        name.trim(),
        type,
        class_name?.trim() || null,
        active,
        id,
      );
    } else {
      db.prepare(
        "INSERT INTO members (code,name,type,class_name) VALUES (?,?,?,?)",
      ).run(code.trim(), name.trim(), type, class_name?.trim() || null);
    }
    res.redirect("/members");
  } catch (e) {
    renderMembers(res, {
      error:
        e.code === "SQLITE_CONSTRAINT_UNIQUE"
          ? "Kode sudah dipakai."
          : "Gagal menyimpan data.",
    });
  }
});
app.post("/members/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0) {
    db.prepare("DELETE FROM members WHERE id = ?").run(id);
  }
  res.redirect("/members");
});

// ---------- QR anggota ----------
// Kartu QR dicetak untuk anggota aktif; ?id= untuk satu kartu, ?type= untuk satu jenis.
app.get("/members/cards", requireAdmin, async (req, res) => {
  const id = Number(req.query.id);
  const type = TYPES.includes(req.query.type) ? req.query.type : "";
  let members;
  if (Number.isInteger(id) && id > 0) {
    members = db.prepare("SELECT * FROM members WHERE id = ?").all(id);
  } else {
    members = db
      .prepare(
        `SELECT * FROM members WHERE active = 1 ${type ? "AND type = ?" : ""}
      ORDER BY type, name`,
      )
      .all(...(type ? [type] : []));
  }
  const cards = await Promise.all(
    members.map(async (m) => ({ ...m, svg: await qrSvg(m.qr_token, 2) })),
  );
  res.render("cards", {
    cards,
    type,
    single: Number.isInteger(id) && id > 0,
    regenerated: req.query.regenerated === "1",
    TYPES,
  });
});
app.get("/members/:id/qr.svg", requireAdmin, async (req, res) => {
  const m = db
    .prepare("SELECT qr_token FROM members WHERE id = ?")
    .get(Number(req.params.id));
  if (!m) return res.status(404).send("Anggota tidak ditemukan.");
  res.type("image/svg+xml").set("Cache-Control", "no-store").send(await qrSvg(m.qr_token));
});
// Ganti token bila kartu hilang: QR lama langsung tidak berlaku.
app.post("/members/:id/regenerate-qr", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0) {
    db.prepare(
      "UPDATE members SET qr_token = lower(hex(randomblob(16))) WHERE id = ?",
    ).run(id);
  }
  res.redirect(`/members/cards?id=${id}&regenerated=1`);
});

// ---------- Absen QR ----------
function recentCheckIns(date, limit = 10) {
  return db
    .prepare(
      `SELECT m.name, m.type, a.check_in_time AS time
    FROM attendance a JOIN members m ON m.id = a.member_id
    WHERE a.date = ? AND m.active = 1 AND a.check_in_time IS NOT NULL
    ORDER BY a.check_in_time DESC LIMIT ?`,
    )
    .all(date, limit)
    .map((r) => ({ name: formatTitleCase(r.name), type: r.type, time: hhmm(r.time) }));
}
function presentSummary(date) {
  const total = db.prepare("SELECT COUNT(*) c FROM members WHERE active = 1").get().c;
  const hadir = db
    .prepare(
      `SELECT COUNT(*) c FROM attendance a JOIN members m ON m.id = a.member_id
    WHERE a.date = ? AND a.status = 'hadir' AND m.active = 1`,
    )
    .get(date).c;
  return { hadir, total };
}
app.get("/scan", requireAdmin, (req, res) => {
  const { date } = nowJakarta();
  res.render("scan", {
    date,
    dateLabel: longDate(date),
    summary: presentSummary(date),
    recent: recentCheckIns(date),
  });
});
app.post("/api/scan", requireAdminApi, (req, res) => {
  const raw = String(req.body?.payload ?? "").trim();
  if (!raw.startsWith(QR_PREFIX) || raw.length !== QR_PREFIX.length + 32) {
    return res.status(422).json({
      ok: false,
      kind: "invalid",
      message: "Ini bukan kartu QR PKBM BMC.",
    });
  }
  const member = db
    .prepare("SELECT id, code, name, type, active FROM members WHERE qr_token = ?")
    .get(raw.slice(QR_PREFIX.length));
  if (!member) {
    return res.status(404).json({
      ok: false,
      kind: "unknown",
      message: "QR tidak dikenali atau kartunya sudah diganti.",
    });
  }
  const who = { name: formatTitleCase(member.name), code: member.code, type: member.type };
  if (!member.active) {
    return res.status(409).json({
      ok: false,
      kind: "inactive",
      member: who,
      message: "Anggota ini nonaktif. Aktifkan dulu di Data Anggota.",
    });
  }

  const { date, time } = nowJakarta();
  const existing = db
    .prepare("SELECT status, check_in_time FROM attendance WHERE member_id = ? AND date = ?")
    .get(member.id, date);

  if (existing && existing.status === "hadir") {
    return res.json({
      ok: true,
      kind: "duplicate",
      member: who,
      time: hhmm(existing.check_in_time),
      message: "Sudah tercatat hadir hari ini.",
      summary: presentSummary(date),
    });
  }

  db.prepare(
    `INSERT INTO attendance (member_id, date, status, note, check_in_time, source)
    VALUES (?, ?, 'hadir', NULL, ?, 'qr')
    ON CONFLICT(member_id, date) DO UPDATE SET
      status = 'hadir', check_in_time = excluded.check_in_time, source = 'qr'`,
  ).run(member.id, date, time);

  res.json({
    ok: true,
    kind: existing ? "overridden" : "checked_in",
    member: who,
    time: hhmm(time),
    previous: existing ? STATUS_LABELS[existing.status] : null,
    message: existing
      ? `Hadir tercatat. Status sebelumnya (${STATUS_LABELS[existing.status]}) diganti.`
      : "Hadir tercatat.",
    summary: presentSummary(date),
  });
});

// ---------- Input absensi ----------
app.get("/attendance", requireAdmin, (req, res) => {
  const date = validDate(req.query.date);
  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.name, m.type, m.class_name, a.status, a.note,
      a.check_in_time, a.source
    FROM members m LEFT JOIN attendance a ON a.member_id = m.id AND a.date = ?
    WHERE m.active = 1 ORDER BY m.type, m.name`,
    )
    .all(date);
  res.render("attendance", {
    date,
    dateLabel: longDate(date),
    prevDate: shiftDate(date, -1),
    nextDate: shiftDate(date, 1),
    isToday: date === today(),
    rows,
    STATUSES,
    STATUS_LABELS,
    saved: req.query.saved,
  });
});
app.post("/attendance", requireAdmin, (req, res) => {
  const date = validDate(req.body.date);
  const up =
    db.prepare(`INSERT INTO attendance (member_id,date,status,note) VALUES (?,?,?,?)
    ON CONFLICT(member_id,date) DO UPDATE SET status=excluded.status, note=excluded.note,
      check_in_time = CASE WHEN excluded.status = 'hadir' THEN attendance.check_in_time END,
      source = CASE WHEN excluded.status = 'hadir' THEN attendance.source ELSE 'manual' END`);
  const exists = db.prepare("SELECT 1 FROM members WHERE id = ?");
  db.transaction(() => {
    for (const [key, st] of Object.entries(req.body)) {
      const m = /^status_(\d+)$/.exec(key);
      if (!m || !STATUSES.includes(st) || !exists.get(Number(m[1]))) continue;
      up.run(
        Number(m[1]),
        date,
        st,
        String(req.body["note_" + m[1]] || "").trim() || null,
      );
    }
  })();
  res.redirect(`/attendance?date=${date}&saved=1`);
});

// ---------- Rekap & laporan ----------
app.get("/recap", requireLogin, (req, res) => {
  const period = ["harian", "mingguan", "bulanan"].includes(req.query.period)
    ? req.query.period
    : "harian";
  const date = validDate(req.query.date);
  const type = TYPES.includes(req.query.type) ? req.query.type : "";
  const [from, to] = getRange(period, date);
  const rows = db
    .prepare(
      `SELECT m.code, m.name, m.type, m.class_name,
      COALESCE(SUM(a.status='hadir'),0) hadir, COALESCE(SUM(a.status='izin'),0) izin,
      COALESCE(SUM(a.status='sakit'),0) sakit, COALESCE(SUM(a.status='alpa'),0) alpa
    FROM members m LEFT JOIN attendance a ON a.member_id = m.id AND a.date BETWEEN ? AND ?
    WHERE m.active = 1 ${type ? "AND m.type = ?" : ""}
    GROUP BY m.id ORDER BY m.type, m.name`,
    )
    .all(...(type ? [from, to, type] : [from, to]))
    .map((r) => {
      const total = r.hadir + r.izin + r.sakit + r.alpa;
      return {
        ...r,
        total,
        pct: total ? Math.round((r.hadir / total) * 100) : 0,
      };
    });

  if (req.query.format === "csv") {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      [
        "Kode",
        "Nama",
        "Jenis",
        "Kelas",
        "Hadir",
        "Izin",
        "Sakit",
        "Alpa",
        "Total",
        "Kehadiran (%)",
      ]
        .map(esc)
        .join(","),
    ];
    rows.forEach((r) =>
      lines.push(
        [
          r.code,
          r.name,
          r.type,
          r.class_name,
          r.hadir,
          r.izin,
          r.sakit,
          r.alpa,
          r.total,
          r.pct,
        ]
          .map(esc)
          .join(","),
      ),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="rekap-${period}-${from}_${to}.csv"`,
    );
    return res.send("\uFEFF" + lines.join("\r\n"));
  }
  res.render("recap", { rows, period, date, type, from, to, TYPES });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Absensi PKBM BMC berjalan di port ${PORT}`);
});
