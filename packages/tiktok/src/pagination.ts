interface NativePageInfo { page: number; page_size: number; total_page?: number; total_number?: number }

/** A filtered empty page proves absence only when native totals are consistent. */
export function nativeListComplete(page: NativePageInfo | undefined, count: number): boolean | null {
  if (!page || page.total_page === undefined || count > page.page_size || page.total_page < page.page && count > 0) return null;
  if (page.total_number !== undefined) {
    const expectedPages = Math.ceil(page.total_number / page.page_size);
    if (page.total_number === 0 ? page.total_page > 1 : page.total_page !== expectedPages) return null;
    const expectedRows = Math.max(0, Math.min(page.page_size, page.total_number - (page.page - 1) * page.page_size));
    if (count !== expectedRows) return null;
  }
  return page.page >= page.total_page;
}
