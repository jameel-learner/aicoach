-- Pilot taxonomy (decision 1): KSEAB → 2nd PUC → Accountancy. Idempotent.
INSERT OR IGNORE INTO boards (id, code, name) VALUES
  ('board_kseab', 'KSEAB', 'Karnataka School Examination and Assessment Board');
INSERT OR IGNORE INTO levels (id, board_id, code, name, sort_order) VALUES
  ('level_kseab_2puc', 'board_kseab', '2PUC', '2nd PUC', 12);
INSERT OR IGNORE INTO subjects (id, code, name, stream) VALUES
  ('subject_accountancy', 'ACCOUNTANCY', 'Accountancy', 'commerce');
INSERT OR IGNORE INTO subject_offerings (id, board_id, level_id, subject_id) VALUES
  ('offering_kseab_2puc_accountancy', 'board_kseab', 'level_kseab_2puc', 'subject_accountancy');
