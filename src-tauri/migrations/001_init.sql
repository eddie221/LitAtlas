-- ═══════════════════════════════════════════════════════════════
-- PaperGraph — MySQL Schema
-- Run once to initialise the database:
--   mysql -u root -p papergraph < migrations/001_init.sql
-- ═══════════════════════════════════════════════════════════════

-- CREATE DATABASE IF NOT EXISTS papergraph
--   CHARACTER SET utf8mb4
--   COLLATE utf8mb4_unicode_ci;

USE papergraph;

-- ── papers ──────────────────────────────────────────────────────
-- Core bibliographic data for each paper.
CREATE TABLE IF NOT EXISTS papers (
  id          VARCHAR(64)    NOT NULL PRIMARY KEY,   -- e.g. "resnet", "vit"
  title       VARCHAR(512)   NOT NULL,
  authors     VARCHAR(512)   NOT NULL,
  year        SMALLINT       NOT NULL,
  venue       VARCHAR(128)   NOT NULL DEFAULT '',
  citations   INT UNSIGNED   NOT NULL DEFAULT 0,
  topic       VARCHAR(64)    NOT NULL DEFAULT '',
  abstract    TEXT(512)      NOT NULL,
  pdf_path    VARCHAR(1024)           DEFAULT NULL,  -- local FS path or NULL
  notes       MEDIUMTEXT              DEFAULT NULL,  -- free-form user notes
  created_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── paper_features ──────────────────────────────────────────────
-- One row per paper. Stores the 6 feature dimensions used by the
-- frontend cosine-similarity engine. input_modality is a
-- comma-separated list (e.g. "rgb,depth") so it can be returned as
-- a plain string and split in JavaScript.
CREATE TABLE IF NOT EXISTS paper_features (
  paper_id        VARCHAR(64)  NOT NULL PRIMARY KEY,
  task            VARCHAR(32)  NOT NULL,
  architecture    VARCHAR(32)  NOT NULL,
  supervision     VARCHAR(32)  NOT NULL,
  input_modality  VARCHAR(128) NOT NULL DEFAULT 'rgb',
  embedding_dim   INT UNSIGNED NOT NULL DEFAULT 256,
  CONSTRAINT fk_pf_paper FOREIGN KEY (paper_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ── paper_edges ─────────────────────────────────────────────────
-- Pre-computed similarity edges between papers.
-- Recomputed and reloaded whenever papers or features change.
CREATE TABLE IF NOT EXISTS paper_edges (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_id   VARCHAR(64)  NOT NULL,
  target_id   VARCHAR(64)  NOT NULL,
  similarity  FLOAT        NOT NULL,        -- cosine similarity 0-1
  weight      TINYINT      NOT NULL DEFAULT 1,  -- 1 weak, 2 medium, 3 strong
  edge_type   VARCHAR(32)  NOT NULL DEFAULT 'related',
  UNIQUE KEY uq_edge (source_id, target_id),
  CONSTRAINT fk_edge_src FOREIGN KEY (source_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_edge_tgt FOREIGN KEY (target_id)
    REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════════════════
-- SEED DATA — 30 Computer Vision papers
-- ═══════════════════════════════════════════════════════════════

INSERT INTO papers (id, title, authors, year, venue, citations, topic, abstract) VALUES

-- Classification
('alexnet',
 'ImageNet Classification with Deep Convolutional Neural Networks',
 'Krizhevsky, A., Sutskever, I., Hinton, G. E.',
 2012, 'NeurIPS', 120000, 'Classification',
 'We trained a large, deep CNN to classify 1.2 million ImageNet images into 1000 classes. Introducing ReLU activations, dropout regularisation, and data augmentation, the network achieved top-5 error of 15.3%, sparking the modern deep learning era.'),

('vgg',
 'Very Deep Convolutional Networks for Large-Scale Image Recognition',
 'Simonyan, K., Zisserman, A.',
 2015, 'ICLR', 80000, 'Classification',
 'We investigated the effect of network depth using very small (3x3) convolution filters, showing that 16-19 weight layers significantly improve accuracy. VGGNet became a canonical baseline for transfer learning.'),

('resnet',
 'Deep Residual Learning for Image Recognition',
 'He, K., Zhang, X., Ren, S., Sun, J.',
 2016, 'CVPR', 140000, 'Classification',
 'We introduce residual connections that allow gradients to flow through hundreds of layers without vanishing. ResNet won ILSVRC and COCO 2015, and its skip-connection design underpins nearly every modern deep vision backbone.');

-- ('vit',
--  'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale',
--  'Dosovitskiy, A., Beyer, L., Kolesnikov, A., et al.',
--  2021, 'ICLR', 32000, 'Classification',
--  'We apply a standard Transformer to non-overlapping image patches and pre-train on large datasets. ViT matches or exceeds CNNs on classification benchmarks while requiring less inductive bias.'),

-- ('deit',
--  'Training Data-Efficient Image Transformers and Distillation Through Attention',
--  'Touvron, H., Cord, M., Douze, M., et al.',
--  2021, 'ICML', 8500, 'Classification',
--  'We introduce a teacher-student training strategy specific to ViT using a distillation token, enabling competitive vision transformers trained on ImageNet alone without large external datasets.'),

-- ('convnext',
--  'A ConvNet for the 2020s',
--  'Liu, Z., Mao, H., Wu, C.-Y., et al.',
--  2022, 'CVPR', 7200, 'Classification',
--  'Starting from ResNet and gradually modernising toward ViT design choices, we build ConvNeXt, a pure CNN that rivals modern transformers without self-attention.'),

-- -- Object Detection
-- ('rcnn',
--  'Rich Feature Hierarchies for Accurate Object Detection and Semantic Segmentation',
--  'Girshick, R., Donahue, J., Darrell, T., Malik, J.',
--  2014, 'CVPR', 26000, 'Object Detection',
--  'R-CNN combines selective search region proposals with CNN features and SVMs, achieving a 30% mAP improvement on PASCAL VOC 2012.'),

-- ('fasterrcnn',
--  'Faster R-CNN: Towards Real-Time Object Detection with Region Proposal Networks',
--  'Ren, S., He, K., Girshick, R., Sun, J.',
--  2015, 'NeurIPS', 55000, 'Object Detection',
--  'We introduce a Region Proposal Network (RPN) that shares full-image CNN features with the detection head, making region proposals nearly cost-free.'),

-- ('yolo',
--  'You Only Look Once: Unified, Real-Time Object Detection',
--  'Redmon, J., Divvala, S., Girshick, R., Farhadi, A.',
--  2016, 'CVPR', 30000, 'Object Detection',
--  'YOLO reframes detection as a single regression problem directly from pixels to bounding boxes and class probabilities, achieving 45 fps real-time performance.'),

-- ('detr',
--  'End-to-End Object Detection with Transformers',
--  'Carion, N., Massa, F., Synnaeve, G., et al.',
--  2020, 'ECCV', 8000, 'Object Detection',
--  'DETR formulates detection as a direct set prediction problem using a Transformer encoder-decoder and bipartite matching loss, eliminating handcrafted anchors and NMS.'),

-- ('grounding_dino',
--  'Grounding DINO: Marrying DINO with Grounded Pre-Training for Open-Set Detection',
--  'Liu, S., Zeng, Z., Ren, T., et al.',
--  2023, 'arXiv', 2100, 'Object Detection',
--  'We merge a transformer-based detector with grounded pre-training to build an open-set detector accepting arbitrary text queries.'),

-- -- Segmentation
-- ('fcn',
--  'Fully Convolutional Networks for Semantic Segmentation',
--  'Long, J., Shelhamer, E., Darrell, T.',
--  2015, 'CVPR', 25000, 'Segmentation',
--  'We adapt classification CNNs into dense prediction networks by replacing fully-connected layers with convolutional ones and adding skip connections for fine-grained spatial output.'),

-- ('maskrcnn',
--  'Mask R-CNN',
--  'He, K., Gkioxari, G., Dollar, P., Girshick, R.',
--  2017, 'ICCV', 32000, 'Segmentation',
--  'Mask R-CNN extends Faster R-CNN with a parallel mask branch, enabling instance segmentation by predicting a binary mask for each detected object.'),

-- ('segformer',
--  'SegFormer: Simple and Efficient Design for Semantic Segmentation with Transformers',
--  'Xie, E., Wang, W., Yu, Z., et al.',
--  2021, 'NeurIPS', 5200, 'Segmentation',
--  'SegFormer pairs a hierarchical Mix Transformer encoder with a lightweight MLP decoder, producing strong semantic segmentation without positional encoding.'),

-- ('sam',
--  'Segment Anything',
--  'Kirillov, A., Mintun, E., Ravi, N., et al.',
--  2023, 'ICCV', 6100, 'Segmentation',
--  'SAM introduces a promptable segmentation task and a model that accepts points, boxes, or text prompts to segment any object in any image in zero-shot.'),

-- ('maskdino',
--  'Mask DINO: Towards A Unified Transformer-based Framework for Object Detection and Segmentation',
--  'Li, F., Zhang, H., Liu, S., et al.',
--  2023, 'CVPR', 1400, 'Segmentation',
--  'Mask DINO unifies DINO detection with instance segmentation by sharing queries between detection and mask branches.'),

-- -- Generative Models
-- ('gan',
--  'Generative Adversarial Nets',
--  'Goodfellow, I., Pouget-Abadie, J., Mirza, M., et al.',
--  2014, 'NeurIPS', 52000, 'Generative Models',
--  'GANs frame generation as a minimax game between a generator and a discriminator trained simultaneously, producing realistic samples without explicit density estimation.'),

-- ('stylegan2',
--  'Analyzing and Improving the Image Quality of StyleGAN',
--  'Karras, T., Laine, S., Aila, T., et al.',
--  2020, 'CVPR', 8400, 'Generative Models',
--  'StyleGAN2 redesigns the normalisation layers and generator architecture to remove characteristic artefacts, achieving state-of-the-art unconditional image synthesis quality.'),

-- ('vqvae2',
--  'Generating Diverse High-Fidelity Images with VQ-VAE-2',
--  'Razavi, A., van den Oord, A., Vinyals, O.',
--  2019, 'NeurIPS', 3800, 'Generative Models',
--  'VQ-VAE-2 learns a multi-scale hierarchical discrete latent space and combines it with powerful autoregressive priors to generate high-fidelity images.'),

-- ('ddpm',
--  'Denoising Diffusion Probabilistic Models',
--  'Ho, J., Jain, A., Abbeel, P.',
--  2020, 'NeurIPS', 12000, 'Generative Models',
--  'DDPM learns to reverse a Markovian diffusion process that gradually adds Gaussian noise to images, producing high-quality samples that outperform GANs on FID.'),

-- ('ldm',
--  'High-Resolution Image Synthesis with Latent Diffusion Models',
--  'Rombach, R., Blattmann, A., Lorenz, D., et al.',
--  2022, 'CVPR', 9800, 'Generative Models',
--  'Stable Diffusion operates the diffusion process in the latent space of a pretrained autoencoder, enabling high-resolution text-to-image synthesis via cross-attention conditioning.'),

-- -- 3D Vision
-- ('nerf',
--  'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
--  'Mildenhall, B., Srinivasan, P. P., Tancik, M., et al.',
--  2020, 'ECCV', 14000, '3D Vision',
--  'NeRF represents a scene as a continuous 5D function parameterised by an MLP, enabling photo-realistic novel view synthesis from sparse calibrated images.'),

-- ('3dgs',
--  '3D Gaussian Splatting for Real-Time Novel View Synthesis',
--  'Kerbl, B., Kopanas, G., Leimkuhler, T., Drettakis, G.',
--  2023, 'SIGGRAPH', 3800, '3D Vision',
--  'We use explicit 3D Gaussians and a tile-based differentiable rasteriser to achieve real-time novel view synthesis matching NeRF quality.'),

-- ('pointnet',
--  'PointNet: Deep Learning on Point Sets for 3D Classification and Segmentation',
--  'Qi, C. R., Su, H., Mo, K., Guibas, L. J.',
--  2017, 'CVPR', 13000, '3D Vision',
--  'PointNet directly consumes unordered point clouds with a shared MLP and global max-pooling, achieving permutation-invariant 3D shape classification and segmentation.'),

-- ('instant_ngp',
--  'Instant Neural Graphics Primitives with a Multiresolution Hash Encoding',
--  'Muller, T., Evans, A., Schied, C., Keller, A.',
--  2022, 'SIGGRAPH', 4500, '3D Vision',
--  'We accelerate NeRF training by replacing positional encoding with a multiresolution hash grid of trainable features, reducing training from hours to seconds.'),

-- -- Self-Supervised
-- ('moco',
--  'Momentum Contrast for Unsupervised Visual Representation Learning',
--  'He, K., Fan, H., Wu, Y., Xie, S., Girshick, R.',
--  2020, 'CVPR', 9500, 'Self-Supervised',
--  'MoCo builds a dynamic dictionary with a queue and a momentum-updated encoder, enabling unsupervised learning of rich visual representations via contrastive loss.'),

-- ('mae',
--  'Masked Autoencoders Are Scalable Vision Learners',
--  'He, K., Chen, X., Xie, S., et al.',
--  2022, 'CVPR', 7800, 'Self-Supervised',
--  'MAE randomly masks 75% of image patches and trains a ViT encoder-decoder to reconstruct pixel values, learning representations transferable to many downstream tasks.'),

-- ('dinov2',
--  'DINOv2: Learning Robust Visual Features without Supervision',
--  'Oquab, M., Darcet, T., Moutakanni, T., et al.',
--  2023, 'TMLR', 3200, 'Self-Supervised',
--  'DINOv2 combines self-distillation with curated large-scale data to train ViT models producing general-purpose visual features competitive with supervised models.'),

-- -- Video & Motion
-- ('flownet',
--  'FlowNet: Learning Optical Flow with Convolutional Networks',
--  'Dosovitskiy, A., Fischer, P., Ilg, E., et al.',
--  2015, 'ICCV', 4800, 'Video & Motion',
--  'We show that CNNs can learn optical flow end-to-end from a large synthetic dataset, generalising to real scenes without domain-specific engineering.'),

-- ('slowfast',
--  'SlowFast Networks for Video Recognition',
--  'Feichtenhofer, C., Fan, H., Malik, J., He, K.',
--  2019, 'ICCV', 4200, 'Video & Motion',
--  'SlowFast uses two pathways — slow for spatial semantics and fast for motion — achieving state-of-the-art video classification.'),

-- ('videomaev2',
--  'VideoMAE V2: Scaling Video Masked Autoencoders with Dual Masking',
--  'Wang, L., Huang, B., Zhao, Z., et al.',
--  2023, 'CVPR', 980, 'Video & Motion',
--  'VideoMAE V2 scales masked autoencoding to 1B-parameter video transformers using dual masking, achieving top performance on Kinetics and Something-Something.'),

-- -- Depth & Scene
-- ('monodepth2',
--  'Digging Into Self-Supervised Monocular Depth Estimation',
--  'Godard, C., Mac Aodha, O., Firman, M., Brostow, G. J.',
--  2019, 'ICCV', 4500, 'Depth & Scene',
--  'MonoDepth2 introduces per-pixel minimum reprojection loss and auto-masking to train depth and pose networks jointly from monocular video with no depth supervision.'),

-- ('dpt',
--  'Vision Transformers for Dense Prediction',
--  'Ranftl, R., Bochkovskiy, A., Koltun, V.',
--  2021, 'ICCV', 3100, 'Depth & Scene',
--  'DPT assembles tokens from multiple ViT stages into image-like feature maps and fuses them with a convolutional head for sharp depth estimation and segmentation.'),

-- ('depth_anything',
--  'Depth Anything: Unleashing the Power of Large-Scale Unlabeled Data',
--  'Yang, L., Kang, B., Huang, Z., et al.',
--  2024, 'CVPR', 1200, 'Depth & Scene',
--  'Depth Anything trains a foundation depth model using 62M unlabelled images via student-teacher learning, achieving zero-shot monocular depth estimation superior to specialist models.');

-- ── paper_features seed ─────────────────────────────────────────
INSERT INTO paper_features (paper_id, task, architecture, supervision, input_modality, embedding_dim) VALUES
('alexnet',       'classification',    'cnn',         'supervised',        'rgb',            4096),
('vgg',           'classification',    'cnn',         'supervised',        'rgb',            4096),
('resnet',        'classification',    'cnn',         'supervised',        'rgb',            2048);
-- ('vit ',           'classification',    'transformer', 'supervised',        'rgb',            1024),
-- ('deit',          'classification',    'transformer', 'supervised',        'rgb',             768),
-- ('convnext',      'classification',    'cnn',         'supervised',        'rgb',            1024),
-- ('rcnn',          'detection',         'cnn',         'supervised',        'rgb',            4096),
-- ('fasterrcnn',    'detection',         'cnn',         'supervised',        'rgb',            2048),
-- ('yolo',          'detection',         'cnn',         'supervised',        'rgb',             512),
-- ('detr',          'detection',         'transformer', 'supervised',        'rgb',             256),
-- ('grounding_dino','detection',         'transformer', 'weakly_supervised', 'rgb,text',        256),
-- ('fcn',           'segmentation',      'cnn',         'supervised',        'rgb',             512),
-- ('maskrcnn',      'segmentation',      'cnn',         'supervised',        'rgb',            2048),
-- ('segformer',     'segmentation',      'transformer', 'supervised',        'rgb',             512),
-- ('sam',           'segmentation',      'hybrid',      'self_supervised',   'rgb,text',        256),
-- ('maskdino',      'segmentation',      'transformer', 'supervised',        'rgb',             256),
-- ('gan',           'generation',        'gan',         'unsupervised',      'rgb',             512),
-- ('stylegan2',     'generation',        'gan',         'unsupervised',      'rgb',             512),
-- ('vqvae2',        'generation',        'vae',         'unsupervised',      'rgb',             256),
-- ('ddpm',          'generation',        'diffusion',   'unsupervised',      'rgb',             512),
-- ('ldm',           'generation',        'diffusion',   'unsupervised',      'rgb,text',        512),
-- ('nerf',          '3d_reconstruction', 'mlp',         'supervised',        'rgb,multi_view',  256),
-- ('3dgs',          '3d_reconstruction', 'mlp',         'supervised',        'rgb,multi_view',  128),
-- ('pointnet',      '3d_reconstruction', 'mlp',         'supervised',        'depth,lidar',    1024),
-- ('instant_ngp',   '3d_reconstruction', 'mlp',         'supervised',        'rgb,multi_view',  256),
-- ('moco',          'classification',    'cnn',         'self_supervised',   'rgb',             128),
-- ('mae',           'classification',    'transformer', 'self_supervised',   'rgb',            1024),
-- ('dinov2',        'classification',    'transformer', 'self_supervised',   'rgb',            1536),
-- ('flownet',       'optical_flow',      'cnn',         'supervised',        'rgb,video',       512),
-- ('slowfast',      'tracking',          'cnn',         'supervised',        'rgb,video',      2048),
-- ('videomaev2',    'tracking',          'transformer', 'self_supervised',   'rgb,video',      1408),
-- ('monodepth2',    'depth_estimation',  'cnn',         'self_supervised',   'rgb',             512),
-- ('dpt',           'depth_estimation',  'hybrid',      'supervised',        'rgb',             768),
-- ('depth_anything','depth_estimation',  'transformer', 'semi_supervised',   'rgb',            1024);

-- ── paper_edges will be populated at runtime by the Rust backend ─
-- (call the `recompute_edges` Tauri command after first launch)