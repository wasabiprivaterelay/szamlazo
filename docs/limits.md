# Limits, and the legal ground

## What this version does not do

Read this before relying on szamlazo. Each of these is refused by the API,
not quietly mishandled; none is hard to add, but none is there yet.

| Not supported | What happens | Instead, for now |
|---|---|---|
| Currencies other than forint | Every invoice is HUF | — |
| Buyers outside Hungary (EU or third country): intra-EU supply (KBAET), export (EAM), EU reverse charge | Postcode must be Hungarian; no foreign VAT numbers | Another program for those invoices, with a different prefix |
| Margin scheme (különbözet szerinti adózás), simplified invoices | — | — |
| Pénzforgalmi elszámolás (cash accounting) | Not marked on the invoice or at NAV | Do not use this version if you have opted for it |
| Net-priced lines | Prices are gross (VAT included), as in retail | Work out the gross price before sending |
| Fractional quantities (1.5 kg), zero or negative lines (discounts) | Quantities are whole numbers from 1; prices from 0 | Discounted price on the line itself |
| Modifying invoices (helyesbítő számla) | Only a full reversal (storno) | Storno, then a new invoice |
| Advance invoices (előlegszámla), final invoices against them | — | — |
| Several companies or several number series in one installation | One seller, one prefix | One installation per company |
| Paper invoices, duplicates (másolat) printed later | The PDF is the invoice; download it again any time | — |
| Inbound invoices (bejövő számlák) | Not stored; `npm run nav -- digest … --inbound` lists them from NAV | — |

**Numbering** runs on across years: `SZ2026/00131` is followed by
`SZ2027/00132`. The law asks for numbers that are unique and continuous
within a series; the year in the number is for people.

## The legal ground

This is how szamlazo meets the rules as its authors understand them. It is not
legal or tax advice: have your accountant confirm it for your business before
you go live, and whenever your situation changes.

**Invoice content** (Áfa tv. 169. §). Seller and buyer names and addresses,
the seller's tax number, the buyer's for a business buyer, the issue and
fulfilment dates, a unique sequential number, line descriptions, quantities
and units, unit prices, VAT rate, net, VAT and gross per rate and in total.
All on the PDF; a storno also names the invoice it reverses.

**Real-time reporting** (Áfa tv. 10. melléklet; NAV Online Számla). Every
invoice and storno issued by software is reported to NAV straight after it is
issued, for every buyer, private or business. The checker keeps trying while
NAV is unreachable and alerts you if it cannot within an hour.

**The invoicing program** (23/2014. (VI. 30.) NGM rendelet). It must not let
an invoice be changed or deleted, must number without gaps, and must produce
an export of the invoices in a given range for a tax inspection. szamlazo
enforces the first two in the database itself and provides the third
(`szamlazo export`, `GET /v1/exports/inspection`). The separate announcement
of invoicing programs to NAV (the old SZAMLAZO form) was abolished from 4
January 2021; the program identifies itself in every report instead
(`NAV_SOFTWARE_…`).

**Electronic invoices** (Áfa tv. 175. §). An invoice sent as a PDF by email is
an electronic invoice, which needs **the buyer's agreement**. A web shop
usually gets it in its terms and conditions ("the invoice is sent
electronically"). Its authenticity and integrity are kept by business
controls: the audit log, the stored SHA-256 of every PDF and the nightly
check of both, and NAV's own copy of every invoice's data.

**Keeping invoices** (Számv. tv. 169. §). Eight years. The PDFs are kept in
your storage with their fingerprints, the data in Postgres, an encrypted
backup in R2, and a monthly copy in the archive mailbox. Keep at least two of
these for the full eight years, and keep them readable: an export of the old
years before you ever shut an installation down.

**Personal data** (GDPR). See [security.md](security.md#what-is-left-to-you).
