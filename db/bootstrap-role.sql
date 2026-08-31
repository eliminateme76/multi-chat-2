DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sceneweaver') THEN
    CREATE ROLE sceneweaver LOGIN PASSWORD 'sceneweaver_dev_password';
  END IF;
END
$$;