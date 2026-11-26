function formatTitleCase(name) {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("id-ID")
    .replace(/(^|[\s'-])(\p{L})/gu, (_, separator, letter) =>
      separator + letter.toLocaleUpperCase("id-ID"),
    );
}

module.exports = { formatTitleCase };
