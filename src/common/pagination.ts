export type PaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export function paginationMeta(total: number, requestedPage: number, pageSize: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(requestedPage, totalPages), pageSize, total, totalPages };
}
