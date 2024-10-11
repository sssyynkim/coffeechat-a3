const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { fromSSO } = require("@aws-sdk/credential-provider-sso"); // Use SSO credentials for AWS
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { getParameterValue } = require("../config/secretsManager"); // Use SecretsManager for credentials

const getS3Credentials = async () => {
  const accessKeyId = await getParameterValue("/n11725605/prac-accessKeyId");
  const secretAccessKey = await getParameterValue(
    "/n11725605/prac-secretAccessKey"
  );
  const sessionToken = await getParameterValue("/n11725605/prac-sessionToken");
  const region = await getParameterValue("/n11725605/AWS_REGION");

  return { accessKeyId, secretAccessKey, sessionToken, region };
};

// Function to generate a pre-signed URL for file upload with user ID included
const getPreSignedUrlWithUser = async (fileName, userId) => {
  // Fetch AWS_BUCKET_NAME and AWS_REGION from Parameter Store
  const { accessKeyId, secretAccessKey, sessionToken, region } =
    await getS3Credentials();
  const bucketName = await getParameterValue("/n11725605/AWS_BUCKET_NAME");
  const s3Client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  });

  const key = `${userId}/${fileName}`; // Use user ID as part of the file key
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ACL: "public-read", // Adjust ACL as needed
    Metadata: {
      "uploaded-by": userId, // Add user info to metadata
    },
  });

  try {
    const preSignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });
    return preSignedUrl;
  } catch (err) {
    console.error("Error generating pre-signed URL:", err);
    throw err;
  }
};

// Upload the file to S3 using a pre-signed URL
const uploadFileToS3 = async (fileBuffer, preSignedUrl, contentType) => {
  try {
    console.log("Uploading file to S3...");
    console.log("File size:", fileBuffer.length);

    const response = await fetch(preSignedUrl, {
      method: "PUT",
      body: fileBuffer,
      headers: {
        "Content-Type": contentType,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.statusText}`);
    }

    console.log("File uploaded successfully!");
  } catch (err) {
    console.error("Error uploading file:", err);
    throw err;
  }
};

// Function to generate a pre-signed URL for reading a file from S3
const getPreSignedReadUrl = async (fileName) => {
  // Fetch AWS_BUCKET_NAME and AWS_REGION from Parameter Store
  const { accessKeyId, secretAccessKey, sessionToken, region } =
    await getS3Credentials();
  const bucketName = await getParameterValue("/n11725605/AWS_BUCKET_NAME");
  const s3Client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  });

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileName,
  });

  try {
    const preSignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    }); // URL expires in 1 hour
    return preSignedUrl;
  } catch (err) {
    console.error("Error generating pre-signed read URL:", err);
    throw err;
  }
};

// Delete an image from S3
const deleteImageFromS3 = async (fileKey) => {
  // Fetch AWS_BUCKET_NAME and AWS_REGION from Parameter Store
  const { accessKeyId, secretAccessKey, sessionToken, region } =
    await getS3Credentials();
  const bucketName = await getParameterValue("/n11725605/AWS_BUCKET_NAME");
  const s3Client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  });

  const params = {
    Bucket: bucketName,
    Key: fileKey,
  };

  try {
    await s3Client.send(new DeleteObjectCommand(params));
    console.log(`File ${fileKey} deleted successfully from S3`);
  } catch (err) {
    console.error("Error deleting file from S3:", err);
    throw new Error("Error deleting file from S3");
  }
};

// Export the S3 functions for external use in other parts of the application
module.exports = {
  getPreSignedUrlWithUser,
  uploadFileToS3,
  getPreSignedReadUrl,
  deleteImageFromS3,
};
