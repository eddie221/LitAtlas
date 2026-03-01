-- ═══════════════════════════════════════════════════════════════════════════
-- PaperGraph — Schema v2
--
-- Run on top of an existing v1 database:
--   mysql -u root -p papergraph < migrations/002_redesign.sql
--
-- Or for a clean start (drops everything first):
--   mysql -u root -p -e "DROP DATABASE IF EXISTS papergraph; CREATE DATABASE papergraph CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
--   mysql -u root -p papergraph < migrations/002_redesign.sql
--
-- ── What changed from v1 ─────────────────────────────────────────────────────
--   papers       : dropped `authors` (VARCHAR), `topic` (moved to hashtags)
--                  kept title, year, venue, citations, abstract, pdf_path, notes
--   paper_authors: NEW — ordered multi-author rows per paper
--   hashtags     : NEW — normalised tag names
--   paper_tags   : NEW — many-to-many: papers ↔ hashtags
--   projects     : NEW — logical grouping of papers
--   paper_projects: NEW — many-to-many: papers ↔ projects
--   paper_relations: NEW — typed directed relations between papers
--                  (cites, extends, contrasts, uses, inspired_by, replicated_by)
--   paper_features: kept, input_modality re-enabled as a proper sub-table
--   paper_modalities: NEW — many-to-many: papers ↔ modalities
--   paper_edges  : kept, stores computed similarity scores
-- ═══════════════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS papergraph2
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE papergraph2;

-- ── 0. Safely remove v1 tables that are being replaced ───────────────────────
-- We drop child tables first to respect FK constraints.

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS paper_edges;
DROP TABLE IF EXISTS paper_features;
DROP TABLE IF EXISTS papers;

-- New tables (idempotent — safe to re-run)
DROP TABLE IF EXISTS paper_modalities;
DROP TABLE IF EXISTS paper_features;
DROP TABLE IF EXISTS paper_edges;
DROP TABLE IF EXISTS paper_relations;
DROP TABLE IF EXISTS paper_projects;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS paper_tags;
DROP TABLE IF EXISTS hashtags;
DROP TABLE IF EXISTS paper_authors;
DROP TABLE IF EXISTS papers;

SET FOREIGN_KEY_CHECKS = 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- CORE TABLES
-- ═══════════════════════════════════════════════════════════════════════════

-- ── projects ─────────────────────────────────────────────────────────────────
-- A project is a user-defined collection of papers (e.g. a research theme,
-- a reading list, a grant proposal).  Papers can belong to many projects.
CREATE TABLE projects (
  id          VARCHAR(64)   NOT NULL PRIMARY KEY,   -- slug, e.g. "cv_foundations"
  name        VARCHAR(256)  NOT NULL,
  description TEXT                   DEFAULT NULL,
  color       VARCHAR(7)    NOT NULL DEFAULT '#6b7280', -- hex, for UI badges
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── papers ───────────────────────────────────────────────────────────────────
-- One row per paper.  Authors and hashtags live in their own tables.
CREATE TABLE papers (
  id          VARCHAR(64)    NOT NULL PRIMARY KEY,   -- human slug, e.g. "resnet"
  title       VARCHAR(512)   NOT NULL,
  year        SMALLINT       NOT NULL,
  venue       VARCHAR(128)   NOT NULL DEFAULT '',
  citations   INT UNSIGNED   NOT NULL DEFAULT 0,
  abstract    TEXT           NOT NULL ,
  pdf_path    VARCHAR(1024)           DEFAULT NULL,  -- local filesystem path
  notes       MEDIUMTEXT              DEFAULT NULL,  -- free-form user notes
  created_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,

  FULLTEXT KEY ft_title_abstract (title, abstract)   -- enables fast text search
) ENGINE=InnoDB;

-- ── paper_authors ─────────────────────────────────────────────────────────────
-- Ordered list of authors per paper.
-- `position` is 1-based: 1 = first author, 2 = second, etc.
CREATE TABLE paper_authors (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  paper_id    VARCHAR(64)   NOT NULL,
  name        VARCHAR(256)  NOT NULL,
  position    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_paper_author_pos (paper_id, position),
  KEY         idx_author_name (name(64)),
  CONSTRAINT fk_pa_paper FOREIGN KEY (paper_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ── hashtags ─────────────────────────────────────────────────────────────────
-- Normalised tag names — stored lower-case, trimmed.
-- `category` groups tags into namespaces: topic | method | dataset | other
CREATE TABLE hashtags (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(64)   NOT NULL,
  category    ENUM('topic','method','dataset','other') NOT NULL DEFAULT 'other',
  UNIQUE KEY uq_tag_name (name)
) ENGINE=InnoDB;

-- ── paper_tags ────────────────────────────────────────────────────────────────
-- Many-to-many: papers ↔ hashtags
CREATE TABLE paper_tags (
  paper_id    VARCHAR(64)   NOT NULL,
  tag_id      INT UNSIGNED  NOT NULL,
  PRIMARY KEY (paper_id, tag_id),
  CONSTRAINT fk_pt_paper FOREIGN KEY (paper_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pt_tag FOREIGN KEY (tag_id)
    REFERENCES hashtags(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ── paper_projects ────────────────────────────────────────────────────────────
-- Many-to-many: papers ↔ projects
CREATE TABLE paper_projects (
  paper_id    VARCHAR(64)   NOT NULL,
  project_id  VARCHAR(64)   NOT NULL,
  added_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, project_id),
  CONSTRAINT fk_pp_paper FOREIGN KEY (paper_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pp_project FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════════════════════════════
-- RELATIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- ── paper_relations ───────────────────────────────────────────────────────────
-- Explicit, user-authored directed relations between papers.
-- Distinct from paper_edges which store *computed* cosine-similarity edges.
--
-- relation_type vocabulary:
--   cites          source formally cites target in its references
--   extends        source directly builds on / extends target's method
--   contrasts      source compares against or critiques target
--   uses           source uses target's code / dataset / model
--   inspired_by    looser intellectual lineage
--   replicated_by  target is a replication/reproduction of source
CREATE TABLE paper_relations (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_id       VARCHAR(64)   NOT NULL,
  target_id       VARCHAR(64)   NOT NULL,
  relation_type   ENUM(
    'cites',
    'extends',
    'contrasts',
    'uses',
    'inspired_by',
    'replicated_by'
  ) NOT NULL DEFAULT 'cites',
  note            VARCHAR(512)  DEFAULT NULL,  -- optional free-text annotation
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_relation (source_id, target_id, relation_type),
  CONSTRAINT fk_rel_src FOREIGN KEY (source_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_rel_tgt FOREIGN KEY (target_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ── paper_edges ───────────────────────────────────────────────────────────────
-- Machine-computed similarity edges.  Fully regenerated by the JS engine
-- whenever papers or features change.  Never edited by hand.
CREATE TABLE paper_edges (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_id   VARCHAR(64)   NOT NULL,
  target_id   VARCHAR(64)   NOT NULL,
  similarity  FLOAT         NOT NULL,          -- cosine similarity [0, 1]
  weight      TINYINT       NOT NULL DEFAULT 1, -- 1 weak · 2 medium · 3 strong
  edge_type   VARCHAR(32)   NOT NULL DEFAULT 'related',
  UNIQUE KEY uq_edge (source_id, target_id),
  CONSTRAINT fk_edge_src FOREIGN KEY (source_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_edge_tgt FOREIGN KEY (target_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════════════════════════════
-- FEATURE VECTOR (for ML similarity engine)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── paper_features ────────────────────────────────────────────────────────────
-- One row per paper.  Scalar + categorical features for cosine similarity.
-- input_modality moved to paper_modalities below.
CREATE TABLE paper_features (
  paper_id        VARCHAR(64)  NOT NULL PRIMARY KEY,
  task            VARCHAR(32)  NOT NULL DEFAULT 'classification',
  architecture    VARCHAR(32)  NOT NULL DEFAULT 'cnn',
  supervision     VARCHAR(32)  NOT NULL DEFAULT 'supervised',
  embedding_dim   INT UNSIGNED NOT NULL DEFAULT 256,
  CONSTRAINT fk_pf_paper FOREIGN KEY (paper_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ── paper_modalities ──────────────────────────────────────────────────────────
-- Multi-valued modality list, previously stored as a CSV string.
-- modality: rgb | depth | lidar | video | multi_view | text
CREATE TABLE paper_modalities (
  paper_id  VARCHAR(64)  NOT NULL,
  modality  VARCHAR(32)  NOT NULL,
  PRIMARY KEY (paper_id, modality),
  CONSTRAINT fk_pm_paper FOREIGN KEY (paper_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════════════════════════════
-- VIEWS  (convenient read-only projections used by the Rust layer)
-- ═══════════════════════════════════════════════════════════════════════════

-- Flat paper view: aggregates authors and tags into comma-separated strings
-- for use in the existing Rust query layer without N+1 queries.
CREATE OR REPLACE VIEW v_papers AS
SELECT
    p.id,
    p.title,
    p.year,
    p.venue,
    p.citations,
    p.abstract,
    p.pdf_path,
    p.notes,
    p.created_at,
    p.updated_at,
    -- Authors: "Last F., Last F." ordered by position
    COALESCE(
        GROUP_CONCAT(DISTINCT pa.name ORDER BY pa.position SEPARATOR ', '),
        ''
    )                                   AS authors,
    -- Hashtags: "#tag1,#tag2"
    COALESCE(
        GROUP_CONCAT(DISTINCT CONCAT('#', h.name) ORDER BY h.name SEPARATOR ','),
        ''
    )                                   AS hashtags,
    -- Projects: "slug1,slug2"
    COALESCE(
        GROUP_CONCAT(DISTINCT pp_join.project_id ORDER BY pp_join.project_id SEPARATOR ','),
        ''
    )                                   AS project_ids,
    -- Features (NULL if not set yet)
    f.task,
    f.architecture,
    f.supervision,
    f.embedding_dim,
    -- Modalities: "rgb,depth"
    COALESCE(
        GROUP_CONCAT(DISTINCT pm.modality ORDER BY pm.modality SEPARATOR ','),
        ''
    )                                   AS modalities
FROM papers p
LEFT JOIN paper_authors   pa      ON pa.paper_id  = p.id
LEFT JOIN paper_tags      pt      ON pt.paper_id  = p.id
LEFT JOIN hashtags        h       ON h.id         = pt.tag_id
LEFT JOIN paper_projects  pp_join ON pp_join.paper_id = p.id
LEFT JOIN paper_features  f       ON f.paper_id   = p.id
LEFT JOIN paper_modalities pm     ON pm.paper_id  = p.id
GROUP BY p.id
ORDER BY p.year ASC, p.id ASC;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Projects ─────────────────────────────────────────────────────────────────
INSERT INTO projects (id, name, description, color) VALUES
('cv_foundations', 'CV Foundations',    'Backbone architectures and classification', '#c8ff00'),
('detection_seg',  'Detection & Seg',   'Object detection and segmentation papers',  '#00d4ff'),
('generative',     'Generative Models', 'GANs, VAEs, diffusion models',             '#a855f7'),
('3d_scene',       '3D & Scene',        'NeRF, point clouds, depth estimation',      '#f43f5e'),
('self_sup',       'Self-Supervised',   'Contrastive and masked learning',           '#34d399');

-- ── Hashtags ─────────────────────────────────────────────────────────────────
INSERT INTO hashtags (name, category) VALUES
-- topic tags
('classification',     'topic'),
('object-detection',   'topic'),
('segmentation',       'topic'),
('generative',         'topic'),
('3d-vision',          'topic'),
('self-supervised',    'topic'),
('video',              'topic'),
('depth-estimation',   'topic'),
('optical-flow',       'topic'),
-- method tags
('cnn',                'method'),
('transformer',        'method'),
('diffusion',          'method'),
('gan',                'method'),
('vae',                'method'),
('mlp',                'method'),
('nerf',               'method'),
('contrastive',        'method'),
('masked-autoencoder', 'method'),
-- dataset tags
('imagenet',           'dataset'),
('coco',               'dataset'),
('kinetics',           'dataset');

-- ── Papers ───────────────────────────────────────────────────────────────────
INSERT INTO papers (id, title, year, venue, citations, abstract) VALUES
('alexnet', 'ImageNet Classification with Deep Convolutional Neural Networks',
  2012, 'NeurIPS', 120000,
  'We trained a large, deep CNN to classify 1.2 million ImageNet images into 1000 classes. Introducing ReLU activations, dropout regularisation, and data augmentation, the network achieved top-5 error of 15.3%, sparking the modern deep learning era.'),
('vgg', 'Very Deep Convolutional Networks for Large-Scale Image Recognition',
  2015, 'ICLR', 80000,
  'We investigated the effect of network depth using very small (3x3) convolution filters, showing that 16-19 weight layers significantly improve accuracy. VGGNet became a canonical baseline for transfer learning.'),
('resnet', 'Deep Residual Learning for Image Recognition',
  2016, 'CVPR', 140000,
  'We introduce residual connections that allow gradients to flow through hundreds of layers without vanishing. ResNet won ILSVRC and COCO 2015.'),
('vit', 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale',
  2021, 'ICLR', 32000,
  'We apply a standard Transformer to non-overlapping image patches. ViT matches or exceeds CNNs on classification benchmarks while requiring less inductive bias.'),
('deit', 'Training Data-Efficient Image Transformers and Distillation Through Attention',
  2021, 'ICML', 8500,
  'We introduce a teacher-student strategy specific to ViT using a distillation token, enabling competitive vision transformers trained on ImageNet alone.'),
('convnext', 'A ConvNet for the 2020s',
  2022, 'CVPR', 7200,
  'Starting from ResNet and gradually modernising toward ViT design choices, we build ConvNeXt, a pure CNN that rivals modern transformers.'),
('rcnn', 'Rich Feature Hierarchies for Accurate Object Detection and Semantic Segmentation',
  2014, 'CVPR', 26000,
  'R-CNN combines selective search region proposals with CNN features and SVMs, achieving a 30% mAP improvement on PASCAL VOC 2012.'),
('fasterrcnn', 'Faster R-CNN: Towards Real-Time Object Detection with Region Proposal Networks',
  2015, 'NeurIPS', 55000,
  'We introduce a Region Proposal Network (RPN) that shares full-image CNN features with the detection head, making region proposals nearly cost-free.'),
('yolo', 'You Only Look Once: Unified, Real-Time Object Detection',
  2016, 'CVPR', 30000,
  'YOLO reframes detection as a single regression problem directly from pixels to bounding boxes and class probabilities, achieving 45 fps real-time performance.'),
('detr', 'End-to-End Object Detection with Transformers',
  2020, 'ECCV', 8000,
  'DETR formulates detection as a direct set prediction problem using a Transformer encoder-decoder and bipartite matching loss, eliminating handcrafted anchors and NMS.'),
('grounding_dino', 'Grounding DINO: Marrying DINO with Grounded Pre-Training for Open-Set Detection',
  2023, 'arXiv', 2100,
  'We merge a transformer-based detector with grounded pre-training to build an open-set detector accepting arbitrary text queries.'),
('fcn', 'Fully Convolutional Networks for Semantic Segmentation',
  2015, 'CVPR', 25000,
  'We adapt classification CNNs into dense prediction networks by replacing fully-connected layers with convolutional ones and adding skip connections.'),
('maskrcnn', 'Mask R-CNN',
  2017, 'ICCV', 32000,
  'Mask R-CNN extends Faster R-CNN with a parallel mask branch, enabling instance segmentation.'),
('segformer', 'SegFormer: Simple and Efficient Design for Semantic Segmentation with Transformers',
  2021, 'NeurIPS', 5200,
  'SegFormer pairs a hierarchical Mix Transformer encoder with a lightweight MLP decoder for strong semantic segmentation.'),
('sam', 'Segment Anything',
  2023, 'ICCV', 6100,
  'SAM introduces a promptable segmentation model that accepts points, boxes, or text prompts to segment any object in zero-shot.'),
('maskdino', 'Mask DINO: Towards A Unified Transformer-based Framework for Object Detection and Segmentation',
  2023, 'CVPR', 1400,
  'Mask DINO unifies detection and instance segmentation by sharing queries between detection and mask branches.'),
('gan', 'Generative Adversarial Nets',
  2014, 'NeurIPS', 52000,
  'GANs frame generation as a minimax game between a generator and discriminator, producing realistic samples without explicit density estimation.'),
('stylegan2', 'Analyzing and Improving the Image Quality of StyleGAN',
  2020, 'CVPR', 8400,
  'StyleGAN2 redesigns normalisation layers to remove characteristic artefacts, achieving state-of-the-art unconditional image synthesis quality.'),
('vqvae2', 'Generating Diverse High-Fidelity Images with VQ-VAE-2',
  2019, 'NeurIPS', 3800,
  'VQ-VAE-2 learns a multi-scale hierarchical discrete latent space combined with powerful autoregressive priors to generate high-fidelity images.'),
('ddpm', 'Denoising Diffusion Probabilistic Models',
  2020, 'NeurIPS', 12000,
  'DDPM learns to reverse a Markovian diffusion process that gradually adds Gaussian noise, producing high-quality samples that outperform GANs on FID.'),
('ldm', 'High-Resolution Image Synthesis with Latent Diffusion Models',
  2022, 'CVPR', 9800,
  'Stable Diffusion operates the diffusion process in the latent space of a pretrained autoencoder, enabling high-resolution text-to-image synthesis.'),
('nerf', 'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
  2020, 'ECCV', 14000,
  'NeRF represents a scene as a continuous 5D function parameterised by an MLP for photo-realistic novel view synthesis from sparse calibrated images.'),
('3dgs', '3D Gaussian Splatting for Real-Time Novel View Synthesis',
  2023, 'SIGGRAPH', 3800,
  'We use explicit 3D Gaussians and a tile-based differentiable rasteriser to achieve real-time novel view synthesis matching NeRF quality.'),
('pointnet', 'PointNet: Deep Learning on Point Sets for 3D Classification and Segmentation',
  2017, 'CVPR', 13000,
  'PointNet directly consumes unordered point clouds with a shared MLP and global max-pooling for permutation-invariant 3D shape understanding.'),
('instant_ngp', 'Instant Neural Graphics Primitives with a Multiresolution Hash Encoding',
  2022, 'SIGGRAPH', 4500,
  'We accelerate NeRF training using a multiresolution hash grid of trainable features, reducing training from hours to seconds.'),
('moco', 'Momentum Contrast for Unsupervised Visual Representation Learning',
  2020, 'CVPR', 9500,
  'MoCo builds a dynamic dictionary with a queue and a momentum-updated encoder for unsupervised contrastive visual representation learning.'),
('mae', 'Masked Autoencoders Are Scalable Vision Learners',
  2022, 'CVPR', 7800,
  'MAE randomly masks 75% of image patches and trains a ViT to reconstruct pixels, learning transferable representations.'),
('dinov2', 'DINOv2: Learning Robust Visual Features without Supervision',
  2023, 'TMLR', 3200,
  'DINOv2 combines self-distillation with curated large-scale data to train ViT models producing general-purpose visual features.'),
('flownet', 'FlowNet: Learning Optical Flow with Convolutional Networks',
  2015, 'ICCV', 4800,
  'We show that CNNs can learn optical flow end-to-end from a large synthetic dataset, generalising to real scenes.'),
('slowfast', 'SlowFast Networks for Video Recognition',
  2019, 'ICCV', 4200,
  'SlowFast uses two pathways — slow for spatial semantics and fast for motion — for state-of-the-art video classification.'),
('videomaev2', 'VideoMAE V2: Scaling Video Masked Autoencoders with Dual Masking',
  2023, 'CVPR', 980,
  'VideoMAE V2 scales masked autoencoding to 1B-parameter video transformers using dual masking.'),
('monodepth2', 'Digging Into Self-Supervised Monocular Depth Estimation',
  2019, 'ICCV', 4500,
  'MonoDepth2 introduces per-pixel minimum reprojection loss and auto-masking for joint depth and pose training from monocular video.'),
('dpt', 'Vision Transformers for Dense Prediction',
  2021, 'ICCV', 3100,
  'DPT assembles tokens from multiple ViT stages into image-like feature maps for sharp depth estimation and segmentation.'),
('depth_anything', 'Depth Anything: Unleashing the Power of Large-Scale Unlabeled Data',
  2024, 'CVPR', 1200,
  'Depth Anything trains a foundation depth model using 62M unlabelled images via student-teacher learning for zero-shot monocular depth estimation.');

-- ── Authors ───────────────────────────────────────────────────────────────────
INSERT INTO paper_authors (paper_id, name, position) VALUES
('alexnet', 'Krizhevsky, A.',    1),
('alexnet', 'Sutskever, I.',     2),
('alexnet', 'Hinton, G. E.',     3),
('vgg',     'Simonyan, K.',      1),
('vgg',     'Zisserman, A.',     2),
('resnet',  'He, K.',            1),
('resnet',  'Zhang, X.',         2),
('resnet',  'Ren, S.',           3),
('resnet',  'Sun, J.',           4),
('vit',     'Dosovitskiy, A.',   1),
('vit',     'Beyer, L.',         2),
('vit',     'Kolesnikov, A.',    3),
('deit',    'Touvron, H.',       1),
('deit',    'Cord, M.',          2),
('deit',    'Douze, M.',         3),
('convnext','Liu, Z.',           1),
('convnext','Mao, H.',           2),
('convnext','Wu, C.-Y.',         3),
('rcnn',    'Girshick, R.',      1),
('rcnn',    'Donahue, J.',       2),
('rcnn',    'Darrell, T.',       3),
('rcnn',    'Malik, J.',         4),
('fasterrcnn','Ren, S.',         1),
('fasterrcnn','He, K.',          2),
('fasterrcnn','Girshick, R.',    3),
('fasterrcnn','Sun, J.',         4),
('yolo',    'Redmon, J.',        1),
('yolo',    'Divvala, S.',       2),
('yolo',    'Girshick, R.',      3),
('yolo',    'Farhadi, A.',       4),
('detr',    'Carion, N.',        1),
('detr',    'Massa, F.',         2),
('detr',    'Synnaeve, G.',      3),
('grounding_dino','Liu, S.',     1),
('grounding_dino','Zeng, Z.',    2),
('grounding_dino','Ren, T.',     3),
('fcn',     'Long, J.',          1),
('fcn',     'Shelhamer, E.',     2),
('fcn',     'Darrell, T.',       3),
('maskrcnn','He, K.',            1),
('maskrcnn','Gkioxari, G.',      2),
('maskrcnn','Dollar, P.',        3),
('maskrcnn','Girshick, R.',      4),
('segformer','Xie, E.',          1),
('segformer','Wang, W.',         2),
('segformer','Yu, Z.',           3),
('sam',     'Kirillov, A.',      1),
('sam',     'Mintun, E.',        2),
('sam',     'Ravi, N.',          3),
('maskdino','Li, F.',            1),
('maskdino','Zhang, H.',         2),
('maskdino','Liu, S.',           3),
('gan',     'Goodfellow, I.',    1),
('gan',     'Pouget-Abadie, J.', 2),
('gan',     'Mirza, M.',         3),
('stylegan2','Karras, T.',       1),
('stylegan2','Laine, S.',        2),
('stylegan2','Aila, T.',         3),
('vqvae2',  'Razavi, A.',        1),
('vqvae2',  'van den Oord, A.', 2),
('vqvae2',  'Vinyals, O.',       3),
('ddpm',    'Ho, J.',            1),
('ddpm',    'Jain, A.',          2),
('ddpm',    'Abbeel, P.',        3),
('ldm',     'Rombach, R.',       1),
('ldm',     'Blattmann, A.',     2),
('ldm',     'Lorenz, D.',        3),
('nerf',    'Mildenhall, B.',    1),
('nerf',    'Srinivasan, P. P.', 2),
('nerf',    'Tancik, M.',        3),
('3dgs',    'Kerbl, B.',         1),
('3dgs',    'Kopanas, G.',       2),
('3dgs',    'Leimkuhler, T.',    3),
('3dgs',    'Drettakis, G.',     4),
('pointnet','Qi, C. R.',         1),
('pointnet','Su, H.',            2),
('pointnet','Mo, K.',            3),
('pointnet','Guibas, L. J.',     4),
('instant_ngp','Muller, T.',     1),
('instant_ngp','Evans, A.',      2),
('instant_ngp','Schied, C.',     3),
('instant_ngp','Keller, A.',     4),
('moco',    'He, K.',            1),
('moco',    'Fan, H.',           2),
('moco',    'Wu, Y.',            3),
('moco',    'Xie, S.',           4),
('moco',    'Girshick, R.',      5),
('mae',     'He, K.',            1),
('mae',     'Chen, X.',          2),
('mae',     'Xie, S.',           3),
('dinov2',  'Oquab, M.',         1),
('dinov2',  'Darcet, T.',        2),
('dinov2',  'Moutakanni, T.',    3),
('flownet', 'Dosovitskiy, A.',   1),
('flownet', 'Fischer, P.',       2),
('flownet', 'Ilg, E.',           3),
('slowfast','Feichtenhofer, C.', 1),
('slowfast','Fan, H.',           2),
('slowfast','Malik, J.',         3),
('slowfast','He, K.',            4),
('videomaev2','Wang, L.',        1),
('videomaev2','Huang, B.',       2),
('videomaev2','Zhao, Z.',        3),
('monodepth2','Godard, C.',      1),
('monodepth2','Mac Aodha, O.',   2),
('monodepth2','Firman, M.',      3),
('monodepth2','Brostow, G. J.', 4),
('dpt',     'Ranftl, R.',        1),
('dpt',     'Bochkovskiy, A.',   2),
('dpt',     'Koltun, V.',        3),
('depth_anything','Yang, L.',    1),
('depth_anything','Kang, B.',    2),
('depth_anything','Huang, Z.',   3);

-- ── Hashtag assignments ───────────────────────────────────────────────────────
-- Classification papers
-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'alexnet' AS pid UNION SELECT 'vgg' UNION SELECT 'resnet' UNION SELECT 'vit'
--    UNION SELECT 'deit' UNION SELECT 'convnext' UNION SELECT 'moco' UNION SELECT 'mae'
--    UNION SELECT 'dinov2') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'classification';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'alexnet' AS pid UNION SELECT 'vgg' UNION SELECT 'resnet'
--    UNION SELECT 'convnext' UNION SELECT 'moco' UNION SELECT 'rcnn'
--    UNION SELECT 'fasterrcnn' UNION SELECT 'yolo' UNION SELECT 'fcn'
--    UNION SELECT 'maskrcnn' UNION SELECT 'flownet' UNION SELECT 'slowfast') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'cnn';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'vit' AS pid UNION SELECT 'deit' UNION SELECT 'detr' UNION SELECT 'grounding_dino'
--    UNION SELECT 'segformer' UNION SELECT 'sam' UNION SELECT 'maskdino' UNION SELECT 'mae'
--    UNION SELECT 'dinov2' UNION SELECT 'videomaev2' UNION SELECT 'dpt' UNION SELECT 'depth_anything') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'transformer';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'rcnn' AS pid UNION SELECT 'fasterrcnn' UNION SELECT 'yolo' UNION SELECT 'detr'
--    UNION SELECT 'grounding_dino' UNION SELECT 'maskdino') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'object-detection';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'fcn' AS pid UNION SELECT 'maskrcnn' UNION SELECT 'segformer'
--    UNION SELECT 'sam' UNION SELECT 'maskdino') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'segmentation';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'gan' AS pid UNION SELECT 'stylegan2' UNION SELECT 'vqvae2'
--    UNION SELECT 'ddpm' UNION SELECT 'ldm') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'generative';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'ddpm' AS pid UNION SELECT 'ldm') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'diffusion';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'gan' AS pid UNION SELECT 'stylegan2') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'gan';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'vqvae2' AS pid) AS p
--   CROSS JOIN hashtags h WHERE h.name = 'vae';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'nerf' AS pid UNION SELECT '3dgs' UNION SELECT 'pointnet' UNION SELECT 'instant_ngp') AS p
--   CROSS JOIN hashtags h WHERE h.name = '3d-vision';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'nerf' AS pid UNION SELECT '3dgs' UNION SELECT 'instant_ngp') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'nerf';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'moco' AS pid UNION SELECT 'mae' UNION SELECT 'dinov2') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'self-supervised';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'moco' AS pid) AS p
--   CROSS JOIN hashtags h WHERE h.name = 'contrastive';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'mae' AS pid UNION SELECT 'videomaev2') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'masked-autoencoder';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'flownet' AS pid) AS p
--   CROSS JOIN hashtags h WHERE h.name = 'optical-flow';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'slowfast' AS pid UNION SELECT 'videomaev2' UNION SELECT 'flownet') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'video';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'monodepth2' AS pid UNION SELECT 'dpt' UNION SELECT 'depth_anything') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'depth-estimation';

-- INSERT INTO paper_tags (paper_id, tag_id)
-- SELECT p.id, h.id FROM
--   (SELECT 'alexnet' AS pid UNION SELECT 'vgg' UNION SELECT 'resnet' UNION SELECT 'vit'
--    UNION SELECT 'deit' UNION SELECT 'convnext' UNION SELECT 'rcnn' UNION SELECT 'fasterrcnn'
--    UNION SELECT 'yolo' UNION SELECT 'moco' UNION SELECT 'mae' UNION SELECT 'dinov2') AS p
--   CROSS JOIN hashtags h WHERE h.name = 'imagenet';

-- ── Project memberships ───────────────────────────────────────────────────────
INSERT INTO paper_projects (paper_id, project_id) VALUES
('alexnet',       'cv_foundations'), ('vgg', 'cv_foundations'), ('resnet', 'cv_foundations'),
('vit',           'cv_foundations'), ('deit','cv_foundations'), ('convnext','cv_foundations'),
('rcnn',          'detection_seg'),  ('fasterrcnn','detection_seg'), ('yolo','detection_seg'),
('detr',          'detection_seg'),  ('grounding_dino','detection_seg'),
('fcn',           'detection_seg'),  ('maskrcnn','detection_seg'), ('segformer','detection_seg'),
('sam',           'detection_seg'),  ('maskdino','detection_seg'),
('gan',           'generative'),     ('stylegan2','generative'), ('vqvae2','generative'),
('ddpm',          'generative'),     ('ldm','generative'),
('nerf',          '3d_scene'),       ('3dgs','3d_scene'), ('pointnet','3d_scene'),
('instant_ngp',   '3d_scene'),       ('monodepth2','3d_scene'), ('dpt','3d_scene'),
('depth_anything','3d_scene'),
('moco',          'self_sup'),       ('mae','self_sup'), ('dinov2','self_sup');

-- ── Paper features ────────────────────────────────────────────────────────────
INSERT INTO paper_features (paper_id, task, architecture, supervision, embedding_dim) VALUES
('alexnet',        'classification',    'cnn',         'supervised',       4096),
('vgg',            'classification',    'cnn',         'supervised',       4096),
('resnet',         'classification',    'cnn',         'supervised',       2048),
('vit',            'classification',    'transformer', 'supervised',       1024),
('deit',           'classification',    'transformer', 'supervised',        768),
('convnext',       'classification',    'cnn',         'supervised',       1024),
('rcnn',           'detection',         'cnn',         'supervised',       4096),
('fasterrcnn',     'detection',         'cnn',         'supervised',       2048),
('yolo',           'detection',         'cnn',         'supervised',        512),
('detr',           'detection',         'transformer', 'supervised',        256),
('grounding_dino', 'detection',         'transformer', 'weakly_supervised', 256),
('fcn',            'segmentation',      'cnn',         'supervised',        512),
('maskrcnn',       'segmentation',      'cnn',         'supervised',       2048),
('segformer',      'segmentation',      'transformer', 'supervised',        512),
('sam',            'segmentation',      'hybrid',      'self_supervised',   256),
('maskdino',       'segmentation',      'transformer', 'supervised',        256),
('gan',            'generation',        'gan',         'unsupervised',      512),
('stylegan2',      'generation',        'gan',         'unsupervised',      512),
('vqvae2',         'generation',        'vae',         'unsupervised',      256),
('ddpm',           'generation',        'diffusion',   'unsupervised',      512),
('ldm',            'generation',        'diffusion',   'unsupervised',      512),
('nerf',           '3d_reconstruction', 'mlp',         'supervised',        256),
('3dgs',           '3d_reconstruction', 'mlp',         'supervised',        128),
('pointnet',       '3d_reconstruction', 'mlp',         'supervised',       1024),
('instant_ngp',    '3d_reconstruction', 'mlp',         'supervised',        256),
('moco',           'classification',    'cnn',         'self_supervised',   128),
('mae',            'classification',    'transformer', 'self_supervised',  1024),
('dinov2',         'classification',    'transformer', 'self_supervised',  1536),
('flownet',        'optical_flow',      'cnn',         'supervised',        512),
('slowfast',       'tracking',          'cnn',         'supervised',       2048),
('videomaev2',     'tracking',          'transformer', 'self_supervised',  1408),
('monodepth2',     'depth_estimation',  'cnn',         'self_supervised',   512),
('dpt',            'depth_estimation',  'hybrid',      'supervised',        768),
('depth_anything', 'depth_estimation',  'transformer', 'semi_supervised',  1024);

-- ── Paper modalities ──────────────────────────────────────────────────────────
INSERT INTO paper_modalities (paper_id, modality) VALUES
('alexnet','rgb'), ('vgg','rgb'), ('resnet','rgb'), ('vit','rgb'), ('deit','rgb'),
('convnext','rgb'), ('rcnn','rgb'), ('fasterrcnn','rgb'), ('yolo','rgb'),
('detr','rgb'), ('grounding_dino','rgb'), ('grounding_dino','text'),
('fcn','rgb'), ('maskrcnn','rgb'), ('segformer','rgb'),
('sam','rgb'), ('sam','text'), ('maskdino','rgb'),
('gan','rgb'), ('stylegan2','rgb'), ('vqvae2','rgb'), ('ddpm','rgb'),
('ldm','rgb'), ('ldm','text'),
('nerf','rgb'), ('nerf','multi_view'),
('3dgs','rgb'), ('3dgs','multi_view'),
('pointnet','depth'), ('pointnet','lidar'),
('instant_ngp','rgb'), ('instant_ngp','multi_view'),
('moco','rgb'), ('mae','rgb'), ('dinov2','rgb'),
('flownet','rgb'), ('flownet','video'),
('slowfast','rgb'), ('slowfast','video'),
('videomaev2','rgb'), ('videomaev2','video'),
('monodepth2','rgb'), ('dpt','rgb'),
('depth_anything','rgb');

-- ── Paper relations ───────────────────────────────────────────────────────────
INSERT INTO paper_relations (source_id, target_id, relation_type, note) VALUES
-- Detection lineage
('fasterrcnn',   'rcnn',        'extends',     'Introduces RPN to make proposals almost free'),
('yolo',         'rcnn',        'contrasts',   'Single-shot vs two-stage detection'),
('detr',         'fasterrcnn',  'contrasts',   'Anchor-free end-to-end vs anchor-based'),
('grounding_dino','detr',       'extends',     'Adds grounded open-set text conditioning'),
('maskdino',     'detr',        'extends',     'Adds mask branch to DINO detection'),
-- Segmentation lineage
('maskrcnn',     'fasterrcnn',  'extends',     'Adds parallel mask prediction head'),
('sam',          'maskrcnn',    'extends',     'Generalises to promptable zero-shot segmentation'),
-- Classification lineage
('vgg',          'alexnet',     'extends',     'Deeper with uniform 3×3 convolutions'),
('resnet',       'vgg',         'extends',     'Introduces residual skip connections'),
('vit',          'resnet',      'contrasts',   'Replaces convolutions with self-attention'),
('deit',         'vit',         'extends',     'Adds knowledge distillation token'),
('convnext',     'resnet',      'extends',     'Modernises ResNet toward ViT design choices'),
('moco',         'resnet',      'uses',        'Uses ResNet as backbone'),
('mae',          'vit',         'extends',     'Adds masked patch reconstruction pre-training'),
('dinov2',       'mae',         'extends',     'Scales DINO with curated large datasets'),
-- 3D lineage
('instant_ngp',  'nerf',        'extends',     'Hash encoding replaces positional encoding'),
('3dgs',         'nerf',        'contrasts',   'Explicit Gaussians vs implicit MLP field'),
-- Depth
('dpt',          'vit',         'uses',        'Uses ViT as encoder backbone'),
('depth_anything','dpt',        'extends',     'Scales with large unlabelled data'),
('monodepth2',   'resnet',      'uses',        'ResNet encoder for depth and pose networks'),
-- Generative
('stylegan2',    'gan',         'extends',     'Fixes GAN normalisation artefacts'),
('ddpm',         'gan',         'contrasts',   'Diffusion process vs adversarial training'),
('ldm',          'ddpm',        'extends',     'Moves diffusion into VAE latent space'),
-- Video
('videomaev2',   'mae',         'extends',     'Extends masked autoencoding to video'),
('slowfast',     'resnet',      'uses',        'Dual-pathway ResNet for video');

-- ── paper_edges will be populated at runtime by the JS similarity engine ──────
-- Run the Tauri app and it will call computeEdges() + recompute_edges on first launch.