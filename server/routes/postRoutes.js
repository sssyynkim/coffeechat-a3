const express = require("express");
const multer = require("multer");
const router = express.Router();
const ensureAuthenticated = require("../middleware/auth");
const { getDB } = require("../config/db");
const {
  getPreSignedUrlWithUser,
  uploadFileToS3,
  getPreSignedReadUrl,
} = require("../controllers/s3Controller.js");
const { upload } = require("../middleware/fileUpload");
const { ObjectId } = require("mongodb");
const path = require("path");
const { deletePostFromDynamo } = require("../controllers/dynamoController");
const { deleteImageFromS3 } = require("../controllers/s3Controller");
const { getParameterValue } = require("../config/secretsManager");

const { createDynamoDBClient } = require("../controllers/dynamoController");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const AWS = require("@aws-sdk/client-sqs"); // AWS SDK for SQS
const { createSQSClient } = require("../server");

async function sendMessageToSQS(messageBody) {
  try {
    const sqsClient = await createSQSClient();
    const queueUrl =
      "https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11682957-coffeechat-queue"; // 본인 SQS 큐 URL 사용

    const params = {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(messageBody), // 메시지를 JSON 형식으로 변환
    };

    const command = new AWS.SendMessageCommand(params);
    const response = await sqsClient.send(command);

    console.log("SQS Message Sent", response.MessageId);
  } catch (error) {
    console.error("Error sending message to SQS:", error);
  }
}

// Route to render the write post page
router.get("/write", ensureAuthenticated, (req, res) => {
  res.render("write", { user: req.user });
});

// Route to handle adding a new post
router.post(
  "/add",
  ensureAuthenticated,
  multer().single("img1"),
  async (req, res) => {
    try {
      console.log("Post request received");

      // Ensure multer has processed the file
      if (!req.file) {
        return res.status(400).send("No file uploaded");
      }

      // Retrieve bucket name and region from Parameter Store
      const qutUsername = await getParameterValue("/n11725605/QUT_USERNAME");
      const bucketName = await getParameterValue("/n11725605/AWS_BUCKET_NAME");
      const region = await getParameterValue("/n11725605/AWS_REGION");

      // Generate a unique file name and postId
      const userId = req.user.sub || req.user.email; // Cognito user ID or email
      const fileName = Date.now() + path.extname(req.file.originalname);
      const postId = uuidv4(); // Generate postId here using uuidv4
      console.log("Generated postId:", postId);
      console.log("Generated fileName:", fileName);

      // Generate a pre-signed URL for uploading the file to S3
      const preSignedUrl = await getPreSignedUrlWithUser(fileName, userId);
      if (!preSignedUrl) {
        throw new Error("Failed to generate pre-signed URL");
      }
      console.log("Pre-Signed URL:", preSignedUrl);

      // Upload the file to S3
      const fileBuffer = req.file.buffer;
      const contentType = req.file.mimetype;
      console.log("File Buffer:", fileBuffer);
      console.log("Content Type:", contentType);

      await uploadFileToS3(fileBuffer, preSignedUrl, contentType); // Upload to S3

      // Create post data to insert into MongoDB
      const postData = {
        ...req.body,
        imageUrl: `https://${bucketName}.s3.${region}.amazonaws.com/${userId}/${fileName}`, // Store S3 URL
        user: userId, // Using Cognito user ID
        createdAt: new Date(),
      };

      await getDB().collection("post").insertOne(postData);

      // Additionally, store post data in DynamoDB
      const dynamoPostData = {
        "qut-username": qutUsername, // Partition key from Parameter Store
        postId: postId, // Sort key (UUID)
        title: req.body.title,
        content: req.body.content,
        imageUrl: postData.imageUrl, // S3 file URL
        timestamp: new Date().toISOString(),
        uploadedBy: userId, // Using Cognito user ID
      };

      const docClient = await createDynamoDBClient();
      await docClient.send(
        new PutCommand({
          TableName: await getParameterValue("/n11725605/DYNAMO_TABLE_NAME"), // DynamoDB table from Parameter Store
          Item: dynamoPostData,
        })
      );

      // SQS로 메시지 전송
      const messageBody = {
        postId: postId,
        title: req.body.title,
        content: req.body.content,
        imageUrl: postData.imageUrl,
        userId: userId,
      };
      await sendMessageToSQS(messageBody); // SQS에 메시지 전송

      res.redirect("/posts/list");
    } catch (err) {
      console.error("Failed to add post:", err);
      res.status(500).send("An unexpected error occurred.");
    }
  }
);

// Route to get all posts
router.get("/list", ensureAuthenticated, async (req, res) => {
  try {
    const posts = await getDB()
      .collection("post")
      .aggregate([
        {
          $lookup: {
            from: "comment",
            localField: "_id",
            foreignField: "parentId",
            as: "comments",
          },
        },
        {
          $addFields: {
            commentCount: { $size: "$comments" },
          },
        },
        {
          $sort: { createdAt: -1 },
        },
        {
          $project: {
            comments: 0,
          },
        },
      ])
      .toArray();

    res.render("list", { posts, user: req.user });
  } catch (err) {
    console.error("Failed to fetch posts:", err);
    res.status(500).send("Failed to fetch posts");
  }
});

// Route to get details of a specific post by postId
router.get("/detail/:postId", ensureAuthenticated, async (req, res) => {
  const { postId } = req.params;

  try {
    // Validate the ObjectId
    if (!ObjectId.isValid(postId)) {
      return res.status(400).send("Invalid post ID");
    }

    // Fetch the post from MongoDB
    const post = await getDB()
      .collection("post")
      .findOne({ _id: new ObjectId(postId) });

    if (!post) {
      return res.status(404).send("Post not found");
    }

    // Fetch the related comments from MongoDB
    const comments = await getDB()
      .collection("comment")
      .find({ parentId: new ObjectId(postId) })
      .toArray();

    // Render the detail view with the post and comments
    res.render("detail", { result: post, result2: comments, user: req.user });
  } catch (err) {
    console.error("Failed to fetch post details:", err);
    res.status(500).send("Error fetching post details");
  }
});

// Route to render the edit page for a specific post by ID
router.get("/edit/:id", ensureAuthenticated, async (req, res) => {
  try {
    const postId = req.params.id;

    if (!ObjectId.isValid(postId)) {
      return res.status(400).send("Invalid post ID");
    }

    const post = await getDB()
      .collection("post")
      .findOne({ _id: new ObjectId(postId) });

    if (!post) {
      return res.status(404).send("Post not found");
    }

    res.render("edit", { result: post });
  } catch (err) {
    console.error("Failed to load the edit page:", err);
    res.status(500).send("Failed to load the edit page");
  }
});

// Route to handle updating a specific post by ID
router.post(
  "/edit/:id",
  ensureAuthenticated,
  upload.single("img1"),
  async (req, res) => {
    try {
      const postId = req.params.id;
      const updateData = {
        title: req.body.title,
        content: req.body.content,
        updatedAt: new Date(),
      };

      if (!ObjectId.isValid(postId)) {
        return res.status(400).send("Invalid post ID");
      }

      if (req.file) {
        const userId = req.user.sub || req.user.email;
        const fileName = Date.now() + path.extname(req.file.originalname);
        const bucketName = await getParameterValue(
          "/n11725605/AWS_BUCKET_NAME"
        );
        const region = await getParameterValue("/n11725605/AWS_REGION");
        const preSignedUrl = await getPreSignedUrlWithUser(fileName, userId);

        updateData.imageUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${userId}/${fileName}`;
        updateData.preSignedUrl = preSignedUrl;
      }

      await getDB()
        .collection("post")
        .updateOne({ _id: new ObjectId(postId) }, { $set: updateData });

      res.redirect("/posts/list");
    } catch (err) {
      console.error("Failed to update post:", err);
      res.status(500).send("Failed to update post");
    }
  }
);

// Route to handle deleting a specific post by ID
router.delete("/delete/:postId", ensureAuthenticated, async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.sub || req.user.email;

  try {
    const qutUsername = await getParameterValue("/n11725605/QUT_USERNAME");
    console.log("Deleting post with postId:", postId);
    console.log("Using qutUsername:", qutUsername);

    const post = await getDB()
      .collection("post")
      .findOne({ _id: new ObjectId(postId) });

    if (!post) {
      return res.status(404).send("Post not found");
    }

    if (post.user !== userId) {
      return res.status(403).send("You are not authorized to delete this post");
    }

    await getDB()
      .collection("post")
      .deleteOne({ _id: new ObjectId(postId) });

    await deletePostFromDynamo(postId, qutUsername);

    if (post.imageUrl) {
      const fileKey = post.imageUrl.split(".amazonaws.com/")[1];
      await deleteImageFromS3(fileKey);
    }

    res.status(200).send({ message: "Post deleted successfully" });
  } catch (err) {
    console.error("Error deleting post:", err);
    res.status(500).send("An unexpected error occurred");
  }
});

module.exports = router;
