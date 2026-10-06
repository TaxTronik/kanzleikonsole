CREATE OR REPLACE FUNCTION app.mandate_artifact_sources_valid(aid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT EXISTS(SELECT 1 FROM mandate_artifact a WHERE a.id=aid AND a.tenant_id=app.current_tenant_id() AND
  (a.kind='STRUCTURE' OR (a.kind='OFFBOARDING' AND jsonb_typeof(a.manifest->'snapshot'->'documents')='array'
   AND jsonb_array_length(a.manifest->'snapshot'->'documents')=(SELECT count(*) FROM mandate_artifact_source s WHERE s.artifact_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.manifest->'snapshot'->'documents') expected WHERE NOT EXISTS(
    SELECT 1 FROM mandate_artifact_source s JOIN document_version v ON v.id=s.document_version_id JOIN document d ON d.id=v.document_id
    WHERE s.artifact_id=a.id AND v.id::text=expected->>'versionId' AND d.id::text=expected->>'documentId'
    AND d.tenant_id=a.tenant_id AND d.client_id=a.client_id AND encode(v.sha256,'hex')=s.source_hash AND s.source_hash=expected->>'sha256'
    AND d.classification::text=expected->>'classification' AND d.requires_payroll_access::text=expected->>'requiresPayrollAccess'
    AND v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL AND d.deleted_at IS NULL AND d.gwg_destroyed_at IS NULL AND d.gwg_destruction_requested_at IS NULL
   )))))
$function$;
