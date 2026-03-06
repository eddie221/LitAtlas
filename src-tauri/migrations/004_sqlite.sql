-- ═══════════════════════════════════════════════════════════════════════════
-- LitAtlas  —  Schema v3  (SQLite)
--
-- The database file lives next to the app binary.
-- Tauri resolves the path at startup and passes it to create_pool().
--
-- SQLite differences from the MySQL version:
--   • PRAGMA foreign_keys = ON  must be set per connection
--   • INTEGER PRIMARY KEY is the alias for rowid — auto-increments automatically
--   • No UNSIGNED, no TINYINT, no SMALLINT — all integers are INTEGER
--   • No ENUM — replaced with CHECK constraints
--   • No AUTO_INCREMENT keyword — INTEGER PRIMARY KEY suffices
--   • No ENGINE=InnoDB, no FULLTEXT KEY (FTS5 is separate, not used here)
--   • No CREATE OR REPLACE VIEW — use DROP VIEW IF EXISTS + CREATE VIEW
--   • No CONCAT() function — use || operator
--   • GROUP_CONCAT separator is the second argument, not SEPARATOR keyword
--   • ON UPDATE CASCADE on FK is silently accepted but not always honoured;
--     use triggers if you need it — here CASCADE on DELETE is sufficient
--   • json_object() is available in SQLite ≥ 3.38 (bundled in Tauri ≥ 2)
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;     -- safe for concurrent readers
PRAGMA foreign_keys = ON;

-- ── drop order respects FK dependencies ──────────────────────────────────────
DROP TABLE IF EXISTS paper_edges;
DROP TABLE IF EXISTS paper_relations;
DROP TABLE IF EXISTS paper_tags;
DROP TABLE IF EXISTS paper_attributes;
DROP TABLE IF EXISTS paper_authors;
DROP TABLE IF EXISTS hashtags;
DROP TABLE IF EXISTS papers;


-- ── papers ────────────────────────────────────────────────────────────────────
CREATE TABLE papers (
  id         INTEGER  NOT NULL PRIMARY KEY,  -- rowid alias, auto-increments
  title      TEXT     NOT NULL,
  venue      TEXT     NOT NULL DEFAULT '',
  year       INTEGER  NOT NULL DEFAULT 0,
  notes      TEXT              DEFAULT NULL,
  pdf_path   TEXT              DEFAULT NULL,
  created_at TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Emulate ON UPDATE updated_at (SQLite has no ON UPDATE column default)
CREATE TRIGGER papers_updated_at
AFTER UPDATE ON papers
FOR EACH ROW
BEGIN
  UPDATE papers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;


-- ── paper_authors ─────────────────────────────────────────────────────────────
CREATE TABLE paper_authors (
  id       INTEGER NOT NULL PRIMARY KEY,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  position INTEGER NOT NULL DEFAULT 1,
  UNIQUE (paper_id, position)
);
CREATE INDEX idx_author_name ON paper_authors (name);


-- ── hashtags ──────────────────────────────────────────────────────────────────
CREATE TABLE hashtags (
  id   INTEGER NOT NULL PRIMARY KEY,
  name TEXT    NOT NULL,
  UNIQUE (name)
);


-- ── paper_tags ────────────────────────────────────────────────────────────────
CREATE TABLE paper_tags (
  paper_id INTEGER NOT NULL REFERENCES papers(id)   ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);


-- ── paper_attributes ─────────────────────────────────────────────────────────
CREATE TABLE paper_attributes (
  id            INTEGER NOT NULL PRIMARY KEY,
  paper_id      INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attr_key      TEXT    NOT NULL,
  attr_value    TEXT    NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (paper_id, attr_key)
);


-- ── paper_relations ───────────────────────────────────────────────────────────
CREATE TABLE paper_relations (
  id            INTEGER NOT NULL PRIMARY KEY,
  source_id     INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  target_id     INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  relation_type TEXT    NOT NULL DEFAULT 'cites'
                        CHECK (relation_type IN (
                          'cites','extends','contrasts',
                          'uses','inspired_by','replicated_by'
                        )),
  note          TEXT             DEFAULT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_id, target_id, relation_type)
);


-- ── paper_edges ───────────────────────────────────────────────────────────────
CREATE TABLE paper_edges (
  id         INTEGER NOT NULL PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  similarity REAL    NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 1,
  edge_type  TEXT    NOT NULL DEFAULT 'related',
  UNIQUE (source_id, target_id)
);


-- ── v_papers (view) ───────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_papers;
CREATE VIEW v_papers AS
SELECT
    p.id,
    p.title,
    p.venue,
    p.year,
    p.notes,
    p.pdf_path,
    p.created_at,
    p.updated_at,
    -- "Last F., Last F." ordered by position
    COALESCE(
      (SELECT GROUP_CONCAT(pa.name, ', ')
       FROM (SELECT name FROM paper_authors
             WHERE paper_id = p.id ORDER BY position) pa),
      ''
    ) AS authors,
    -- "#tag1,#tag2" sorted alphabetically
    COALESCE(
      (SELECT GROUP_CONCAT('#' || h.name, ',')
       FROM (SELECT h2.name FROM hashtags h2
             JOIN paper_tags pt ON pt.tag_id = h2.id
             WHERE pt.paper_id = p.id ORDER BY h2.name) h),
      ''
    ) AS hashtags,
    -- JSON array: [{key, value, order}, ...]
    COALESCE(
      (SELECT '[' || GROUP_CONCAT(
                json_object('key', attr_key, 'value', attr_value, 'order', display_order)
              , ',') || ']'
       FROM (SELECT attr_key, attr_value, display_order FROM paper_attributes
             WHERE paper_id = p.id ORDER BY display_order, attr_key)),
      '[]'
    ) AS attributes_json
FROM papers p
ORDER BY p.year ASC, p.id ASC;



-- -- ═══════════════════════════════════════════════════════════════════════════
-- -- SEED DATA (small)
-- -- ═══════════════════════════════════════════════════════════════════════════
-- sample_seed.sql
-- Minimal seed for LitAtlas: AlexNet, Transformer, ResNet
-- Compatible with migrations/004_sqlite.sql (SQLite dialect)
-- Load with: sqlite3 LitAtlas.db < sample_seed.sql

-- ── Papers ────────────────────────────────────────────────────────────────────

INSERT INTO papers (id, title, venue, year, notes) VALUES
  (1, 'ImageNet Classification with Deep Convolutional Neural Networks',
      'NeurIPS', 2012,
      'Introduced AlexNet, demonstrated deep CNNs on large-scale image classification. Won ILSVRC 2012 by a large margin.'),
  (2, 'Attention Is All You Need',
      'NeurIPS', 2017,
      'Proposed the Transformer architecture based solely on attention mechanisms, replacing RNNs for sequence transduction tasks.'),
  (3, 'Deep Residual Learning for Image Recognition',
      'CVPR',    2016,
      'Introduced residual (skip) connections to train very deep networks (up to 152 layers). Won ILSVRC 2015.');

-- ── Authors ───────────────────────────────────────────────────────────────────

INSERT INTO paper_authors (paper_id, name, position) VALUES
  (1, 'Krizhevsky A.',  1),
  (1, 'Sutskever I.',   2),
  (1, 'Hinton G.',      3),

  (2, 'Vaswani A.',     1),
  (2, 'Shazeer N.',     2),
  (2, 'Parmar N.',      3),
  (2, 'Uszkoreit J.',   4),
  (2, 'Jones L.',       5),
  (2, 'Gomez A.',       6),
  (2, 'Kaiser L.',      7),
  (2, 'Polosukhin I.',  8),

  (3, 'He K.',          1),
  (3, 'Zhang X.',       2),
  (3, 'Ren S.',         3),
  (3, 'Sun J.',         4);

-- ── Hashtags ──────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO hashtags (name) VALUES
  ('classification'),
  ('generative'),
  ('object-detection'),
  ('cnn');

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 1, id FROM hashtags WHERE name = 'classification';

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 1, id FROM hashtags WHERE name = 'cnn';

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 2, id FROM hashtags WHERE name = 'generative';

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 2, id FROM hashtags WHERE name = 'classification';

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 3, id FROM hashtags WHERE name = 'classification';

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 3, id FROM hashtags WHERE name = 'object-detection';

INSERT INTO paper_tags (paper_id, tag_id)
  SELECT 3, id FROM hashtags WHERE name = 'cnn';

-- ── Custom attributes (abstract) ──────────────────────────────────────────────

INSERT INTO paper_attributes (paper_id, attr_key, attr_value, display_order) VALUES
  (1, 'abstract', 'We trained a large, deep convolutional neural network to classify the 1.2 million high-resolution images in the ImageNet LSVRC-2010 contest into the 1000 different classes. The neural network, which has 60 million parameters and 650,000 neurons, consists of five convolutional layers, some of which are followed by max-pooling layers, and three fully-connected layers with a final 1000-way softmax.', 1),
  (2, 'abstract', 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable.', 1),
  (3, 'abstract', 'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions with reference to the layer inputs. We provide comprehensive empirical evidence showing that these residual networks are easier to optimize and can gain accuracy from considerably increased depth.', 1);
-- -- ═══════════════════════════════════════════════════════════════════════════
-- -- SEED DATA (large)
-- -- ═══════════════════════════════════════════════════════════════════════════

-- INSERT INTO papers (title, venue, year) VALUES
-- ('ImageNet Classification with Deep Convolutional Neural Networks', 'NeurIPS', 2012),
-- ('Very Deep Convolutional Networks for Large-Scale Image Recognition', 'ICLR', 2015),
-- ('Deep Residual Learning for Image Recognition', 'CVPR', 2016),
-- ('An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale', 'ICLR', 2021),
-- ('Training Data-Efficient Image Transformers and Distillation Through Attention', 'ICML', 2021),
-- ('A ConvNet for the 2020s', 'CVPR', 2022),
-- ('Rich Feature Hierarchies for Accurate Object Detection and Semantic Segmentation', 'CVPR', 2014),
-- ('Faster R-CNN: Towards Real-Time Object Detection with Region Proposal Networks', 'NeurIPS', 2015),
-- ('You Only Look Once: Unified, Real-Time Object Detection', 'CVPR', 2016),
-- ('End-to-End Object Detection with Transformers', 'ECCV', 2020),
-- ('Grounding DINO: Marrying DINO with Grounded Pre-Training for Open-Set Detection', 'arXiv', 2023),
-- ('Fully Convolutional Networks for Semantic Segmentation', 'CVPR', 2015),
-- ('Mask R-CNN', 'ICCV', 2017),
-- ('SegFormer: Simple and Efficient Design for Semantic Segmentation with Transformers', 'NeurIPS', 2021),
-- ('Segment Anything', 'ICCV', 2023),
-- ('Mask DINO: Towards A Unified Transformer-based Framework for Object Detection and Segmentation', 'CVPR', 2023),
-- ('Generative Adversarial Nets', 'NeurIPS', 2014),
-- ('Analyzing and Improving the Image Quality of StyleGAN', 'CVPR', 2020),
-- ('Generating Diverse High-Fidelity Images with VQ-VAE-2', 'NeurIPS', 2019),
-- ('Denoising Diffusion Probabilistic Models', 'NeurIPS', 2020),
-- ('High-Resolution Image Synthesis with Latent Diffusion Models', 'CVPR', 2022),
-- ('NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis', 'ECCV', 2020),
-- ('3D Gaussian Splatting for Real-Time Novel View Synthesis', 'SIGGRAPH', 2023),
-- ('PointNet: Deep Learning on Point Sets for 3D Classification and Segmentation', 'CVPR', 2017),
-- ('Instant Neural Graphics Primitives with a Multiresolution Hash Encoding', 'SIGGRAPH', 2022),
-- ('Momentum Contrast for Unsupervised Visual Representation Learning', 'CVPR', 2020),
-- ('Masked Autoencoders Are Scalable Vision Learners', 'CVPR', 2022),
-- ('DINOv2: Learning Robust Visual Features without Supervision', 'TMLR', 2023),
-- ('FlowNet: Learning Optical Flow with Convolutional Networks', 'ICCV', 2015),
-- ('SlowFast Networks for Video Recognition', 'ICCV', 2019),
-- ('VideoMAE V2: Scaling Video Masked Autoencoders with Dual Masking', 'CVPR', 2023),
-- ('Digging Into Self-Supervised Monocular Depth Estimation', 'ICCV', 2019),
-- ('Vision Transformers for Dense Prediction', 'ICCV', 2021),
-- ('Depth Anything: Unleashing the Power of Large-Scale Unlabeled Data', 'CVPR', 2024);


-- INSERT INTO paper_authors (paper_id, name, position) VALUES
-- (1,'Krizhevsky, A.',1),(1,'Sutskever, I.',2),(1,'Hinton, G. E.',3),
-- (2,'Simonyan, K.',1),(2,'Zisserman, A.',2),
-- (3,'He, K.',1),(3,'Zhang, X.',2),(3,'Ren, S.',3),(3,'Sun, J.',4),
-- (4,'Dosovitskiy, A.',1),(4,'Beyer, L.',2),(4,'Kolesnikov, A.',3),
-- (5,'Touvron, H.',1),(5,'Cord, M.',2),(5,'Douze, M.',3),
-- (6,'Liu, Z.',1),(6,'Mao, H.',2),(6,'Wu, C.-Y.',3),
-- (7,'Girshick, R.',1),(7,'Donahue, J.',2),(7,'Darrell, T.',3),(7,'Malik, J.',4),
-- (8,'Ren, S.',1),(8,'He, K.',2),(8,'Girshick, R.',3),(8,'Sun, J.',4),
-- (9,'Redmon, J.',1),(9,'Divvala, S.',2),(9,'Girshick, R.',3),(9,'Farhadi, A.',4),
-- (10,'Carion, N.',1),(10,'Massa, F.',2),(10,'Synnaeve, G.',3),
-- (11,'Liu, S.',1),(11,'Zeng, Z.',2),(11,'Ren, T.',3),
-- (12,'Long, J.',1),(12,'Shelhamer, E.',2),(12,'Darrell, T.',3),
-- (13,'He, K.',1),(13,'Gkioxari, G.',2),(13,'Dollar, P.',3),(13,'Girshick, R.',4),
-- (14,'Xie, E.',1),(14,'Wang, W.',2),(14,'Yu, Z.',3),
-- (15,'Kirillov, A.',1),(15,'Mintun, E.',2),(15,'Ravi, N.',3),
-- (16,'Li, F.',1),(16,'Zhang, H.',2),(16,'Liu, S.',3),
-- (17,'Goodfellow, I.',1),(17,'Pouget-Abadie, J.',2),(17,'Mirza, M.',3),
-- (18,'Karras, T.',1),(18,'Laine, S.',2),(18,'Aila, T.',3),
-- (19,'Razavi, A.',1),(19,'van den Oord, A.',2),(19,'Vinyals, O.',3),
-- (20,'Ho, J.',1),(20,'Jain, A.',2),(20,'Abbeel, P.',3),
-- (21,'Rombach, R.',1),(21,'Blattmann, A.',2),(21,'Lorenz, D.',3),
-- (22,'Mildenhall, B.',1),(22,'Srinivasan, P. P.',2),(22,'Tancik, M.',3),
-- (23,'Kerbl, B.',1),(23,'Kopanas, G.',2),(23,'Leimkuhler, T.',3),(23,'Drettakis, G.',4),
-- (24,'Qi, C. R.',1),(24,'Su, H.',2),(24,'Mo, K.',3),(24,'Guibas, L. J.',4),
-- (25,'Muller, T.',1),(25,'Evans, A.',2),(25,'Schied, C.',3),(25,'Keller, A.',4),
-- (26,'He, K.',1),(26,'Fan, H.',2),(26,'Wu, Y.',3),(26,'Xie, S.',4),(26,'Girshick, R.',5),
-- (27,'He, K.',1),(27,'Chen, X.',2),(27,'Xie, S.',3),
-- (28,'Oquab, M.',1),(28,'Darcet, T.',2),(28,'Moutakanni, T.',3),
-- (29,'Dosovitskiy, A.',1),(29,'Fischer, P.',2),(29,'Ilg, E.',3),
-- (30,'Feichtenhofer, C.',1),(30,'Fan, H.',2),(30,'Malik, J.',3),(30,'He, K.',4),
-- (31,'Wang, L.',1),(31,'Huang, B.',2),(31,'Zhao, Z.',3),
-- (32,'Godard, C.',1),(32,'Mac Aodha, O.',2),(32,'Firman, M.',3),(32,'Brostow, G. J.',4),
-- (33,'Ranftl, R.',1),(33,'Bochkovskiy, A.',2),(33,'Koltun, V.',3),
-- (34,'Yang, L.',1),(34,'Kang, B.',2),(34,'Huang, Z.',3);


-- INSERT INTO hashtags (name) VALUES
-- ('classification'),('object-detection'),('segmentation'),('generative'),
-- ('3d-vision'),('self-supervised'),('video'),('depth-estimation'),('optical-flow'),
-- ('cnn'),('transformer'),('diffusion'),('gan'),('vae'),('mlp'),('nerf'),
-- ('contrastive'),('masked-autoencoder'),('imagenet'),('real-time');


-- INSERT INTO paper_tags (paper_id, tag_id) VALUES
-- (1,1),(1,10),(1,19), (2,1),(2,10),(2,19), (3,1),(3,10),(3,19),
-- (4,1),(4,11),(4,19), (5,1),(5,11),(5,19), (6,1),(6,10),
-- (7,2),(7,10),        (8,2),(8,10),(8,20),  (9,2),(9,10),(9,20),
-- (10,2),(10,11),      (11,2),(11,11),
-- (12,3),(12,10),      (13,3),(13,10),       (14,3),(14,11),
-- (15,3),(15,11),      (16,3),(16,11),
-- (17,4),(17,13),      (18,4),(18,13),       (19,4),(19,14),
-- (20,4),(20,12),      (21,4),(21,12),
-- (22,5),(22,15),(22,16),  (23,5),(23,15),(23,16),(23,20),
-- (24,5),(24,15),          (25,5),(25,15),(25,16),
-- (26,6),(26,17),(26,10),  (27,6),(27,18),(27,11),  (28,6),(28,18),(28,11),
-- (29,9),(29,10),      (30,7),(30,10),       (31,7),(31,11),(31,18),
-- (32,8),(32,10),      (33,8),(33,11),       (34,8),(34,11);


-- INSERT INTO paper_attributes (paper_id, attr_key, attr_value, display_order) VALUES
-- (1,'abstract','We trained a large, deep CNN to classify 1.2 million ImageNet images into 1000 classes using ReLU activations, dropout, and data augmentation, achieving top-5 error of 15.3% and sparking the modern deep learning era.',0),
-- (1,'citations','120000',1),
-- (2,'abstract','We investigated the effect of network depth with 3×3 convolution filters. 16-19 weight layers significantly improve accuracy. VGGNet became a canonical transfer-learning baseline.',0),
-- (2,'citations','80000',1),
-- (3,'abstract','Residual connections allow gradients to flow through hundreds of layers without vanishing. ResNet won ILSVRC and COCO 2015.',0),
-- (3,'citations','140000',1),
-- (4,'abstract','A standard Transformer applied to non-overlapping image patches matches or exceeds CNNs on classification benchmarks while requiring less inductive bias.',0),
-- (4,'citations','32000',1),
-- (5,'abstract','Teacher-student training with a distillation token enables competitive vision transformers trained on ImageNet alone.',0),
-- (5,'citations','8500',1),
-- (6,'abstract','Starting from ResNet and adopting ViT design choices, ConvNeXt achieves accuracy rivalling modern transformers while remaining a pure CNN.',0),
-- (6,'citations','7200',1),
-- (7,'abstract','Selective search region proposals with CNN features and SVMs achieve 30% mAP improvement on PASCAL VOC 2012.',0),
-- (7,'citations','26000',1),
-- (8,'abstract','A Region Proposal Network shares full-image CNN features with the detection head, making proposals nearly cost-free.',0),
-- (8,'citations','55000',1),
-- (9,'abstract','YOLO reframes detection as a single regression from pixels to bounding boxes and class probabilities, achieving 45 fps.',0),
-- (9,'citations','30000',1),
-- (10,'abstract','Detection as set prediction via Transformer encoder-decoder with bipartite matching loss — eliminates anchors and NMS.',0),
-- (10,'citations','8000',1),
-- (11,'abstract','Merging a transformer detector with grounded pre-training builds an open-set detector that accepts arbitrary text queries.',0),
-- (11,'citations','2100',1),
-- (12,'abstract','Classification CNNs adapted for dense prediction by replacing fully-connected layers with convolutions and adding skip connections.',0),
-- (12,'citations','25000',1),
-- (13,'abstract','Faster R-CNN extended with a parallel mask branch enables instance segmentation.',0),
-- (13,'citations','32000',1),
-- (14,'abstract','A hierarchical Mix Transformer encoder with a lightweight MLP decoder produces strong semantic segmentation.',0),
-- (14,'citations','5200',1),
-- (15,'abstract','A promptable segmentation model that accepts points, boxes, or text prompts to segment any object in zero-shot.',0),
-- (15,'citations','6100',1),
-- (16,'abstract','Mask DINO unifies detection and instance segmentation by sharing queries between detection and mask branches.',0),
-- (16,'citations','1400',1),
-- (17,'abstract','GANs frame generation as a minimax game between a generator and discriminator, producing realistic samples.',0),
-- (17,'citations','52000',1),
-- (18,'abstract','StyleGAN2 redesigns normalisation layers to remove characteristic artefacts, achieving state-of-the-art image synthesis.',0),
-- (18,'citations','8400',1),
-- (19,'abstract','VQ-VAE-2 learns a multi-scale hierarchical discrete latent space combined with autoregressive priors to generate high-fidelity images.',0),
-- (19,'citations','3800',1),
-- (20,'abstract','DDPM learns to reverse a Markovian diffusion process, producing high-quality samples that outperform GANs on FID.',0),
-- (20,'citations','12000',1),
-- (21,'abstract','Stable Diffusion applies the diffusion process in the latent space of a pretrained autoencoder for high-resolution text-to-image synthesis.',0),
-- (21,'citations','9800',1),
-- (22,'abstract','NeRF represents a scene as a continuous 5D function parameterised by an MLP for photo-realistic novel view synthesis.',0),
-- (22,'citations','14000',1),
-- (23,'abstract','Explicit 3D Gaussians and a tile-based differentiable rasteriser achieve real-time novel view synthesis matching NeRF quality.',0),
-- (23,'citations','3800',1),
-- (24,'abstract','PointNet directly consumes unordered point clouds with a shared MLP and global max-pooling for permutation-invariant 3D understanding.',0),
-- (24,'citations','13000',1),
-- (25,'abstract','A multiresolution hash grid replaces positional encoding in NeRF, reducing training from hours to seconds.',0),
-- (25,'citations','4500',1),
-- (26,'abstract','MoCo builds a dynamic dictionary with a queue and a momentum-updated encoder for unsupervised contrastive learning.',0),
-- (26,'citations','9500',1),
-- (27,'abstract','MAE randomly masks 75% of image patches and trains a ViT to reconstruct pixels, learning transferable representations.',0),
-- (27,'citations','7800',1),
-- (28,'abstract','DINOv2 combines self-distillation with curated large-scale data to produce general-purpose visual features.',0),
-- (28,'citations','3200',1),
-- (29,'abstract','CNNs can learn optical flow end-to-end from a large synthetic dataset, generalising to real scenes.',0),
-- (29,'citations','4800',1),
-- (30,'abstract','Two pathways — slow for spatial semantics, fast for motion — achieve state-of-the-art video classification.',0),
-- (30,'citations','4200',1),
-- (31,'abstract','VideoMAE V2 scales masked autoencoding to 1B-parameter video transformers using dual masking.',0),
-- (31,'citations','980',1),
-- (32,'abstract','Per-pixel minimum reprojection loss and auto-masking train depth and pose networks from monocular video.',0),
-- (32,'citations','4500',1),
-- (33,'abstract','DPT assembles tokens from multiple ViT stages into image-like feature maps for sharp depth estimation.',0),
-- (33,'citations','3100',1),
-- (34,'abstract','Depth Anything trains a foundation depth model using 62M unlabelled images via student-teacher learning.',0),
-- (34,'citations','1200',1);


-- INSERT INTO paper_relations (source_id, target_id, relation_type, note) VALUES
-- (8, 7,'extends',      'Introduces RPN to make region proposals almost free'),
-- (9, 7,'contrasts',    'Single-shot vs two-stage detection'),
-- (10,8,'contrasts',    'Anchor-free end-to-end vs anchor-based'),
-- (11,10,'extends',     'Adds grounded open-set text conditioning'),
-- (16,10,'extends',     'Adds mask branch to DINO detection'),
-- (13,8,'extends',      'Adds parallel mask prediction head'),
-- (15,13,'extends',     'Generalises to promptable zero-shot segmentation'),
-- (2, 1,'extends',      'Deeper with uniform 3×3 convolutions'),
-- (3, 2,'extends',      'Introduces residual skip connections'),
-- (4, 3,'contrasts',    'Replaces convolutions with self-attention'),
-- (5, 4,'extends',      'Adds knowledge distillation token'),
-- (6, 3,'extends',      'Modernises ResNet toward ViT design choices'),
-- (26,3,'uses',         'Uses ResNet as the encoder backbone'),
-- (27,4,'extends',      'Adds masked patch reconstruction pre-training'),
-- (28,27,'extends',     'Scales DINO with curated large datasets'),
-- (25,22,'extends',     'Hash encoding replaces positional encoding'),
-- (23,22,'contrasts',   'Explicit Gaussians vs implicit MLP field'),
-- (33,4,'uses',         'Uses ViT as encoder backbone'),
-- (34,33,'extends',     'Scales with 62M unlabelled images'),
-- (32,3,'uses',         'ResNet encoder for depth and pose networks'),
-- (18,17,'extends',     'Fixes GAN normalisation artefacts'),
-- (20,17,'contrasts',   'Diffusion process vs adversarial training'),
-- (21,20,'extends',     'Moves diffusion into VAE latent space'),
-- (31,27,'extends',     'Extends masked autoencoding to video'),
-- (30,3,'uses',         'Dual-pathway ResNet for video');