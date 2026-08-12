-- The application form, as data. -------------------------------------------
-- Angular renders these steps at runtime and derives its validators from them;
-- the API validates the same definition at the draft -> submitted boundary.
insert into public.form_schemas (name, version, active, steps, rules) values (
  'Agricultural operating facility',
  1,
  true,
  $json$[
    {
      "id": "borrower",
      "title": "Borrower details",
      "description": "How we reach you about this file.",
      "fields": [
        { "key": "fullName", "type": "text", "label": "Full name", "required": true, "maxLength": 120 },
        { "key": "email", "type": "text", "label": "Contact email", "required": true, "maxLength": 160 },
        { "key": "phone", "type": "text", "label": "Phone", "maxLength": 40 }
      ]
    },
    {
      "id": "farm",
      "title": "Farm details",
      "description": "The operation the facility will support.",
      "fields": [
        { "key": "farmName", "type": "text", "label": "Farm or operation name", "required": true, "maxLength": 120 },
        { "key": "acreage", "type": "number", "label": "Acreage under management", "required": true, "min": 0, "help": "Minimum 50 acres. Under 100 is reviewed." },
        { "key": "yearsOps", "type": "number", "label": "Years farming", "required": true, "min": 0, "help": "At least 1 year. Under 5 is reviewed." },
        { "key": "cropType", "type": "select", "label": "Primary operation", "required": true, "options": ["Grain", "Dairy", "Mixed", "Livestock"] }
      ]
    },
    {
      "id": "financials",
      "title": "Financials",
      "description": "Last full reporting year.",
      "fields": [
        { "key": "annualRevenue", "type": "number", "label": "Annual revenue", "required": true, "min": 0, "money": true },
        { "key": "existingDebt", "type": "number", "label": "Existing debt", "min": 0, "money": true }
      ]
    },
    {
      "id": "request",
      "title": "Facility requested",
      "fields": [
        { "key": "amount", "type": "number", "label": "Credit limit requested", "required": true, "min": 1, "money": true },
        { "key": "purpose", "type": "select", "label": "Primary purpose", "required": true, "options": ["Equipment", "Operating", "Land"] },
        { "key": "notes", "type": "textarea", "label": "Anything else we should know", "maxLength": 500 }
      ]
    }
  ]$json$::jsonb,
  $json$[
    { "key": "acreage",  "label": "Acreage",             "field": "acreage",  "failBelow": 50, "warnBelow": 100, "unit": "acres" },
    { "key": "tenure",   "label": "Years farming",       "field": "yearsOps", "failBelow": 1,  "warnBelow": 5,   "unit": "years" },
    { "key": "leverage", "label": "Requested vs revenue", "expr": "amount / annualRevenue", "failAbove": 3, "warnAbove": 2, "unit": "x revenue" }
  ]$json$::jsonb
);
