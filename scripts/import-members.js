const path = require('path');
const readExcelFile = require('read-excel-file/node');
const db = require('../src/db');

async function readRoster(filePath, expectedSheet, codePrefix, type) {
  const worksheets = await readExcelFile(filePath, {
    parseNumber: String,
    trim: false,
  });
  const worksheet = worksheets.find(({ sheet }) => sheet === expectedSheet);
  if (!worksheet) {
    throw new Error(`${path.basename(filePath)} tidak memiliki sheet ${expectedSheet}.`);
  }

  const rows = worksheet.data;
  const headers = rows[5].map((value) => String(value).trim().toLowerCase());
  const noColumn = headers.indexOf('no');
  const nameColumn = headers.indexOf('nama');
  const nuptkColumn = headers.indexOf('nuptk');
  if ([noColumn, nameColumn, nuptkColumn].some((index) => index < 0)) {
    throw new Error(`${expectedSheet}: kolom No, Nama, atau NUPTK tidak ditemukan di baris 6.`);
  }

  const members = [];
  for (let index = 6; index < rows.length; index += 1) {
    const row = rows[index];
    const value = (columnIndex) => String(row[columnIndex] ?? '').trim();
    const number = value(noColumn);
    const name = value(nameColumn);
    const nuptk = value(nuptkColumn);
    if (!number && !name && !nuptk) continue;
    if (!name) {
      throw new Error(`${expectedSheet}, baris ${index + 1}: Nama wajib diisi.`);
    }

    const identifier = nuptk || number;
    if (!identifier) {
      throw new Error(`${expectedSheet}, baris ${index + 1}: NUPTK dan No kosong.`);
    }

    members.push({
      code: nuptk || `${codePrefix}-${number}`,
      name,
      type,
    });
  }
  return members;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args[0] === '--dry-run';
  if (dryRun) args.shift();
  const [guruPath, tendikPath, ...extraArgs] = args;
  if (!guruPath || !tendikPath || extraArgs.length) {
    throw new Error(
      'Pemakaian: npm run import:members -- [--dry-run] "<file guru.xlsx>" "<file tendik.xlsx>"',
    );
  }

  const members = [
    ...await readRoster(guruPath, 'DAFTAR GURU', 'GURU', 'tutor'),
    ...await readRoster(tendikPath, 'DAFTAR TENDIK', 'TENDIK', 'staf'),
  ];
  const codes = new Set();
  for (const member of members) {
    const normalizedCode = member.code.toUpperCase();
    if (codes.has(normalizedCode)) {
      throw new Error(`Kode anggota duplikat pada data impor: ${member.code}.`);
    }
    codes.add(normalizedCode);
  }

  if (dryRun) {
    console.log(`Validasi berhasil: ${members.length} anggota; data database tidak diubah.`);
    return;
  }

  const backupPath = path.join(
    __dirname,
    '..',
    `data-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
  );
  await db.backup(backupPath);

  const replaceData = db.transaction((roster) => {
    db.prepare('DELETE FROM attendance').run();
    db.prepare('DELETE FROM members').run();
    const insert = db.prepare(
      'INSERT INTO members (code, name, type, class_name, active) VALUES (?, ?, ?, NULL, 1)',
    );
    for (const member of roster) {
      insert.run(member.code, member.name, member.type);
    }
  });
  replaceData(members);

  console.log(`Impor selesai: ${members.length} anggota aktif.`);
  console.log(`Backup database lama: ${backupPath}`);
}

main().catch((error) => {
  console.error(`Impor gagal: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  db.close();
});
