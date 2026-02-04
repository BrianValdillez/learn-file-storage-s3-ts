import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)){
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE){
    throw new BadRequestError("Thumbnail exceeds 10MB");
  }

  const video = getVideo(cfg.db, videoId)
  if (video === undefined || video.userID != userID){
    throw new UserForbiddenError("Forbidden to user");
  }

  const fileType = file.type;
  if (fileType !== 'image/jpeg' && fileType !== 'image/png'){
    throw new BadRequestError("Invalid file type");
  }

  const videoExt = fileType.split('/')[1];
  const imageData = await file.arrayBuffer();
  const fileName = `${randomBytes(32).toString("base64url")}.${videoExt}`;

  const videoPath = path.join(cfg.assetsRoot, fileName)
  await Bun.write(videoPath, imageData)

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}`;
  console.log("Stored at: " + videoPath);

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
