ALTER TABLE characters ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT '미설정';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS portrait_url TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS portrait_position TEXT NOT NULL DEFAULT '50%';

UPDATE characters SET gender = CASE
  WHEN name IN ('루카','민준','박해원','최도윤','이라','강태오','정우','서도진','민하준','현우','준호','태경','민석','도하','재현','성호') THEN '남성'
  WHEN name = '오르빗' THEN '성별 없음'
  ELSE '여성'
END WHERE gender = '미설정';
UPDATE characters SET gender='남성' WHERE name IN ('최도윤','이라');

UPDATE characters SET portrait_url='/assets/portraits/starlight-academy.png', portrait_position=CASE name WHEN '세라' THEN '0%' WHEN '루카' THEN '50%' ELSE '100%' END WHERE name IN ('세라','루카','미나');
UPDATE characters SET portrait_url='/assets/portraits/lunch-together.png', portrait_position=CASE name WHEN '지우' THEN '0%' WHEN '민석' THEN '50%' ELSE '100%' END WHERE name IN ('지우','민석','수현');
UPDATE characters SET portrait_url='/assets/portraits/day-after-date.png', portrait_position=CASE name WHEN '유나' THEN '0%' WHEN '민지' THEN '50%' ELSE '100%' END WHERE name IN ('유나','민지','혜림');
UPDATE characters SET portrait_url='/assets/portraits/dinner-chat.png', portrait_position=CASE name WHEN '서윤' THEN '0%' WHEN '도하' THEN '50%' ELSE '100%' END WHERE name IN ('서윤','도하','지민');
UPDATE characters SET portrait_url='/assets/portraits/saturday-cafe.png', portrait_position=CASE name WHEN '나영' THEN '0%' WHEN '재현' THEN '50%' ELSE '100%' END WHERE name IN ('나영','재현','성호');
UPDATE characters SET portrait_url='/assets/portraits/neon-ghostship.png', portrait_position=CASE name WHEN '레이븐' THEN '0%' WHEN '민준' THEN '50%' ELSE '100%' END WHERE name IN ('레이븐','민준','오르빗');
UPDATE characters SET portrait_url='/assets/portraits/white-night-base.png', portrait_position=CASE name WHEN '박해원' THEN '0%' WHEN '최도윤' THEN '50%' ELSE '100%' END WHERE name IN ('박해원','최도윤','이라');
UPDATE characters SET portrait_url='/assets/portraits/velvet-midnight.png', portrait_position=CASE name WHEN '윤서진' THEN '0%' WHEN '강태오' THEN '50%' ELSE '100%' END WHERE name IN ('윤서진','강태오','한이레');
UPDATE characters SET portrait_url='/assets/portraits/four-pm.png', portrait_position=CASE name WHEN '소담' THEN '0%' WHEN '정우' THEN '50%' ELSE '100%' END WHERE name IN ('소담','정우','나래');
UPDATE characters SET portrait_url='/assets/portraits/red-mask.png', portrait_position=CASE name WHEN '차유리' THEN '0%' WHEN '서도진' THEN '50%' ELSE '100%' END WHERE name IN ('차유리','서도진','민하준');
UPDATE characters SET portrait_url='/assets/portraits/fridge.png', portrait_position=CASE name WHEN '소연' THEN '0%' WHEN '현우' THEN '50%' ELSE '100%' END WHERE name IN ('소연','현우','미래');
UPDATE characters SET portrait_url='/assets/portraits/laundry.png', portrait_position=CASE name WHEN '은채' THEN '0%' WHEN '준호' THEN '50%' ELSE '100%' END WHERE name IN ('은채','준호','다영');
UPDATE characters SET portrait_url='/assets/portraits/walking-club.png', portrait_position=CASE name WHEN '하린' THEN '0%' WHEN '태경' THEN '50%' ELSE '100%' END WHERE name IN ('하린','태경','예나');
