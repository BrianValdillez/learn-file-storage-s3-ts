import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "bun";
import type { BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import { getVideo, updateVideo } from "../db/videos";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
    if (!videoId) {
      throw new BadRequestError("Invalid video ID");
    }
  
    const token = getBearerToken(req.headers);
    const userID = validateJWT(token, cfg.jwtSecret);
  
    console.log("uploading video", videoId, "by user", userID);
  
    const formData = await req.formData();
    const file = formData.get("video");
    if (!(file instanceof File)){
      throw new BadRequestError("Video file missing");
    }
  
    const MAX_UPLOAD_SIZE = 1 << 30;
    if (file.size > MAX_UPLOAD_SIZE){
      throw new BadRequestError("Video exceeds 1GB");
    }
  
    const video = getVideo(cfg.db, videoId)
    if (video === undefined || video.userID != userID){
      throw new UserForbiddenError("Forbidden to user");
    }
  
    const fileType = file.type;
    if (fileType !== 'video/mp4'){
      throw new BadRequestError("Invalid file type");
    }
  
    const videoExt = fileType.split('/')[1];
    const videoData = await file.arrayBuffer();
    const fileName = `${randomBytes(32).toString("base64url")}.${videoExt}`;
    console.log(`S3 Key: ${fileName}`);
  
    // Write temporary file locally
    const sourceVideoPath = path.join(cfg.assetsRoot, fileName)
    let localFile = Bun.file(sourceVideoPath);
    await Bun.write(localFile, videoData)
    console.log("Temp File: " + sourceVideoPath);

    const aspectRatioStr = await getVideoAspectRatio(sourceVideoPath);

    // Process video
    const processedVideoPath = await processVideoForFastStart(sourceVideoPath);
    await localFile.delete();
    localFile = Bun.file(processedVideoPath);

    // Upload file to S3
    const fileKey = `${aspectRatioStr}/${fileName}`
    const s3File = cfg.s3Client.file(fileKey);
    await s3File.write(localFile, { type: fileType });

    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileKey}`;
    console.log(`URL: ${video.videoURL}`);
    
    // Cleanup
    await localFile.delete();

    updateVideo(cfg.db, video);
    return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string) : Promise<string> {

  const proc = Bun.spawn(["ffprobe", 
    "-v", "error", "-select_streams", "v:0", 
    "-show_entries", "stream=width,height", "-of", "json", filePath]);
  const result = await proc.exited;

  if (result != 0){
    throw new BadRequestError(`Could not parse file: ${filePath}`);
  }

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  console.log(`ffprobe stdout: ${stdoutText}`);

  const matchW = stdoutText.match(/"width": (\d+)/);
  const matchH = stdoutText.match(/"height": (\d+)/);
  if (!matchW || !matchH){
    throw new BadRequestError("Could not find extract video metadata.");
  }

  const width = parseInt(matchW[1]);
  const height = parseInt(matchH[1]);
  const ratio = Math.floor(width / height);

  if (ratio == Math.floor(16.0 / 9)){
    return "landscape";
  }
  if (ratio == Math.floor(9.0 / 16)){
    return "portrait";
  }

  return "other";
}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputFilePath = inputFilePath + ".processed";

  console.log(`Processing for fast start: ${outputFilePath}`);
  const proc = Bun.spawn(["ffmpeg", 
    "-i", inputFilePath, 
    "-movflags", "faststart", "-map_metadata", 0, 
    "-codec", "copy", "-f", "mp4", outputFilePath]);

  const result = await proc.exited;
  if (result != 0){
    throw new BadRequestError("Could not process video for fast start");
  }

  return outputFilePath;
}
