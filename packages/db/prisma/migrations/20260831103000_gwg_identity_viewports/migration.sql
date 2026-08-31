-- GWG-IDENTIFICATION-EVIDENCE-001 / GWG-OCR-ASSIST-001
-- Viewports reference immutable originals; they are not additional evidence files.
ALTER TABLE public.gwg_id_document ADD COLUMN viewports jsonb;
ALTER TABLE public.gwg_id_document ADD CONSTRAINT gwg_id_document_viewports_array
  CHECK (viewports IS NULL OR (jsonb_typeof(viewports) = 'array' AND jsonb_array_length(viewports) <= 2));
