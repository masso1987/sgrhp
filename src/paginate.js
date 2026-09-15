/** Pagination générique pour les endpoints de liste. Rétro-compatible :
 * n'agit que si ?page ou ?pageSize est présent, sinon renvoie null. */
function paginate(list, query) {
  query = query || {};
  if (query.page === undefined && query.pageSize === undefined) return null;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(1000, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, pages);
  const start = (p - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), total, page: p, pageSize, pages };
}
module.exports = { paginate };
