-- AGENT-CALL-BADGE-001: repair historical inbound parent calls answered by VAPI.
-- The completed child SIP leg is the durable evidence that the AI agent answered.
UPDATE calls AS parent
   SET answered_by = 'ai'
 WHERE parent.parent_call_sid IS NULL
   AND parent.direction = 'inbound'
   AND parent.answered_by IS DISTINCT FROM 'ai'
   AND EXISTS (
       SELECT 1
         FROM calls AS child
        WHERE child.parent_call_sid = parent.call_sid
          AND child.company_id = parent.company_id
          AND child.status = 'completed'
          AND child.to_number ~* '^sip:[^@]+@([^@]+\.)*vapi\.ai([?;].*)?$'
   );
