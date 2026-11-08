"use strict";

const listName = "Smiles In Route Driver Login";
const listIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function cloudflareListError(message) {
  return Object.assign(new Error(message), { statusCode: 502 });
}

function driverLoginListConfig() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const listId = process.env.CLOUDFLARE_DRIVER_EMAIL_LIST_ID?.trim();
  const token = process.env.CLOUDFLARE_DRIVER_LIST_TOKEN?.trim();
  if (!/^[a-f0-9]{32}$/i.test(account ?? "") ||
      (listId && !listIdPattern.test(listId)) ||
      !token) return null;

  return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/gateway/lists`, listId, token };
}

async function allowDriverLogin({ url, listId, token }, email) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(6500);
  async function request(suffix, options) {
    let response;
    let data;
    try {
      response = await fetch(url + suffix, { headers, signal, redirect: "error", ...options });
      data = await response.json().catch(() => null);
    } catch {
      throw cloudflareListError(signal.aborted
        ? "Cloudflare took too long to respond. Try Enable login again."
        : "The backend could not reach Cloudflare. Try Enable login again.");
    }
    if (response.status === 401 || response.status === 403) {
      throw cloudflareListError("Cloudflare rejected the token. Check CLOUDFLARE_DRIVER_LIST_TOKEN and its Zero Trust Edit permission in Render.");
    }
    if (signal.aborted) throw cloudflareListError("Cloudflare took too long to respond. Try Enable login again.");
    if (!response.ok || data?.success !== true) {
      throw cloudflareListError("Cloudflare could not confirm the driver email list update.");
    }
    return data;
  }

  const isDriverList = (item) => item?.type === "EMAIL" && item.name === listName;
  let list;
  if (listId) {
    ({ result: list } = await request(`/${listId}`));
    if (!isDriverList(list)) throw cloudflareListError("The configured list ID must point to the Smiles In Route Driver Login email list.");
  } else {
    const { result: lists } = await request("");
    const matches = Array.isArray(lists) ? lists.filter(isDriverList) : [];
    if (matches.length !== 1 || !listIdPattern.test(matches[0].id ?? "")) {
      throw cloudflareListError("Cloudflare must have exactly one User Emails list named Smiles In Route Driver Login.");
    }
    [list] = matches;
    listId = list.id;
  }

  const listPath = `/${listId}`;
  const includesEmail = (items) => Array.isArray(items) &&
    items.some((item) => item?.value?.toLowerCase() === email);
  if (includesEmail(list.items)) return;
  try {
    await request(listPath, { method: "PATCH", body: JSON.stringify({ append: [{ value: email }] }) });
  } catch (error) {
    // The first attempt may have succeeded even if its response was lost.
    const confirmed = await request(listPath + "/items").catch(() => null);
    if (!includesEmail(confirmed?.result)) throw error;
  }
}

module.exports = { allowDriverLogin, driverLoginListConfig };
