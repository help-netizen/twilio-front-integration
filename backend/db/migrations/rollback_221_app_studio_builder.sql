-- Roll back migration 221 (APP-BUILD-001). Safe to run repeatedly.

DROP TABLE IF EXISTS app_builder_usage_counters;
DROP TABLE IF EXISTS app_build_messages;
DROP TABLE IF EXISTS app_build_chats;
DROP TABLE IF EXISTS app_studio_apps;
