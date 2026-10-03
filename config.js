// PUBLIC VALUES ONLY. Everything in this file is visible to anyone who opens the site.
// Never put the owner key file, Supabase service-role keys, or any other secret here.
window.STUDIO365_CONFIG = {
  PRODUCT_NAME: "STUDIO365",
  CONTACT_EMAIL: "hsw365media@gmail.com",

  // ---- Plans, sold on the Shopify store --------------------------------------------
  // Change a price in Shopify AND here. Each purchase is one month; the key maker (admin.html) issues the key.
  // The first FREE_PROJECTS sessions on a device need no plan.
  FREE_PROJECTS: 3,
  SHOP_PRODUCT_URL: "https://hsw365.co/products/studio365-record-tune-mix-and-master-in-your-browser",
  PLANS: [
    { id: "starter", name: "Starter", price: 15, variant: "47998395744417", blurb: "Unlimited projects. Record, tune, mix, master, export." },
    { id: "plus", name: "Plus", price: 20, variant: "47998395777185", blurb: "Adds Tune Pro, vocal stacks and harmonies, six more presets." },
    { id: "pro", name: "Pro", price: 25, variant: "47998395809953", blurb: "Adds the A&R365 record check, release packs and session backups." }
  ],

  // ---- Older Cash App checkout (no longer shown on the site) -------------------------------------------
  // Change a price here and it updates the landing page, the studio and the checkout.
  CASHTAG: "$hsw365",
  PRO_PRICE: 23,          // dollars per month
  PRO_FIRST_MONTH: 15,    // dollars for a new member's first month

  // Public half of the key pair that signs Pro keys. The private half lives only in the
  // owner key file used on the key maker page (admin.html). If you make a new key pair
  // there, paste the new public key here; keys signed by the old pair stop working.
  LICENSE_PUBLIC_KEY: {
    kty: "EC", crv: "P-256",
    x: "LNUFFgy7bIbCJrx34ez5EjVq0SgmFM7Jwv4SSKYRVjU",
    y: "iKtrkat8OLkjCsViZKfnFIl3uxHMO0VV0W6qjKBj6v8"
  },

  // ---- Optional: Supabase ----------------------------------------------------------
  // Leave as-is and Pro requests go out by email instead. To log them in a table,
  // run supabase.sql and paste the project URL and anon/publishable key here.
  SUPABASE_URL: "REPLACE_WITH_SUPABASE_URL",
  SUPABASE_ANON_KEY: "REPLACE_WITH_SUPABASE_ANON_KEY"
};
