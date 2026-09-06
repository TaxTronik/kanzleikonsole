-- MAIL-INBOX-001: Bootstrap default privileges must not permit erasing durable
-- mailbox receipt identities and reimporting the same UID as a new message.
REVOKE DELETE ON public.inbound_mailbox,public.inbound_message,public.inbound_attachment FROM taxtronik_app;
