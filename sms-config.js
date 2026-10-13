// sms4free.co.il API credentials, from the account's API settings page.
// This site has no backend, so this file is embedded in client-side code -
// the SMS page is access-code gated like the rest of the teacher-only
// pages, but anyone who finds the page and views its source can still read
// these values and use them to send SMS on this account. Only keep real
// credentials here if that tradeoff is acceptable; otherwise rotate the
// key in the sms4free account if it's ever exposed somewhere unintended.
export const sms4freeConfig = {
  key: "XB5jG2AWX",
  user: "0584012374",
  pass: "92402537",
};
