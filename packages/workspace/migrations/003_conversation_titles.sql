WITH first_user_messages AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    regexp_replace(btrim(content), E'\\s+', ' ', 'g') AS title
  FROM messages
  WHERE role = 'user' AND btrim(content) <> ''
  ORDER BY conversation_id, created_at ASC
)
UPDATE conversations AS conversation
SET title = left(first_message.title, 120)
FROM first_user_messages AS first_message
WHERE conversation.id = first_message.conversation_id
  AND lower(btrim(conversation.title)) = 'new conversation'
  AND first_message.title <> '';
