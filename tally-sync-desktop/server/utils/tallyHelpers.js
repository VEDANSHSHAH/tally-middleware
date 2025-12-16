// Shared Tally helpers to keep XML/date handling simple and reusable

function extractValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && '_' in value) return value._;
  if (typeof value === 'object' && '$' in value) return value.$;
  return value;
}

function escapeXml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Format date for Tally (YYYYMMDD) or Postgres (YYYY-MM-DD)
function formatTallyDate(date, format = 'tally') {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  if (format === 'tally') {
    return `${year}${month}${day}`;
  }
  return `${year}-${month}-${day}`;
}

function formatTallyDateForDisplay(tallyDate) {
  if (!tallyDate) return '';
  if (String(tallyDate).includes('-') && String(tallyDate).length === 10) {
    return tallyDate;
  }
  if (String(tallyDate).length === 8) {
    return `${tallyDate.substring(0, 4)}-${tallyDate.substring(4, 6)}-${tallyDate.substring(6, 8)}`;
  }
  return tallyDate;
}

function buildCompanyTag(companyName) {
  if (!companyName) return '';
  return `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`;
}

function currentCompanyTag(config) {
  return buildCompanyTag(config?.company?.name);
}

module.exports = {
  buildCompanyTag,
  currentCompanyTag,
  escapeXml,
  extractValue,
  formatTallyDate,
  formatTallyDateForDisplay
};
