-- iter71: pg_trgm-GIN-Indizes für die globale Suche (/api/staff/search)
--
-- Die globale Suche filtert per ILIKE '%q%' (Prisma `contains`) auf mehreren
-- Textspalten. Ein führender Wildcard macht jeden B-Tree-Index unbrauchbar →
-- Sequential Scan pro Tabelle. Bei tausenden Dokumenten/Rechnungen wächst das
-- linear pro Tastenanschlag (Type-Ahead).
--
-- pg_trgm (bereits aktiviert, siehe init) erlaubt GIN-Indizes mit der
-- gin_trgm_ops-Operatorklasse, die ILIKE '%q%' index-gestützt bedienen. Jede
-- Spalte, die in einem OR-Zweig der Suche vorkommt, braucht einen eigenen Index,
-- damit Postgres die OR via BitmapOr index-only auflöst (ein un-indizierter
-- Zweig würde sonst wieder einen Seq-Scan der ganzen Tabelle erzwingen).
--
-- KB (kb_article) nutzt bereits FTS (search_vec) und braucht hier nichts.

-- Mandanten: name + DATEV-/Addison-Nr. + USt-ID (alle 4 im OR der Client-Suche)
CREATE INDEX "client_name_trgm_idx"       ON "client"   USING GIN ("name" gin_trgm_ops);
CREATE INDEX "client_datev_no_trgm_idx"   ON "client"   USING GIN ("datev_no" gin_trgm_ops);
CREATE INDEX "client_addison_no_trgm_idx" ON "client"   USING GIN ("addison_no" gin_trgm_ops);
CREATE INDEX "client_vat_id_trgm_idx"     ON "client"   USING GIN ("vat_id" gin_trgm_ops);

-- Anforderungen: Titel + Beschreibung (OR)
CREATE INDEX "request_title_trgm_idx"       ON "request" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "request_description_trgm_idx" ON "request" USING GIN ("description" gin_trgm_ops);

-- Dokumente: Titel (Einzelspalte; höchstes Volumen)
CREATE INDEX "document_title_trgm_idx" ON "document" USING GIN ("title" gin_trgm_ops);

-- Rechnungen: Nummer + Betreff (OR)
CREATE INDEX "invoice_number_trgm_idx"  ON "invoice" USING GIN ("number" gin_trgm_ops);
CREATE INDEX "invoice_subject_trgm_idx" ON "invoice" USING GIN ("subject" gin_trgm_ops);
