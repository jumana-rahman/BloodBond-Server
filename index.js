const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT;
const uri = process.env.MONGO_DB_URI;

const logger = (req, res, next) => {
  console.log('logger middleware logged', req.params);
  next();
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);
app.use(express.json());




// ─── MongoDB Connection ───────────────────────────────────────────────────────

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB Atlas");

    const db = client.db("bloodbond_db");
    const usersCollection = db.collection("users");
    const sessionCollection = db.collection("session");
    const donationRequestsCollection = db.collection("donationRequests");
    const fundingsCollection = db.collection("fundings");

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTH ROUTES
    // ═══════════════════════════════════════════════════════════════════════════

    // Called by better-auth on server side to issue a JWT for your own API
    // POST /api/auth/token  →  { email } → { token }
    // Your session.js getUserToken() returns better-auth's session token.
    // This endpoint exchanges the user's email (after better-auth validates them)
    // for a JWT your Express server can verify independently.

    // verification
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res
          .status(401)
          .json({ message: "Unauthorized: No token provided" });
      }

      const token = authHeader.split(" ")[1];

      // Find session
      const session = await sessionCollection.findOne({ token });

      if (!session) {
        return res
          .status(401)
          .json({ message: "Unauthorized: Invalid session" });
      }

      // Find user
      const user = await usersCollection.findOne({
        _id: session.userId,
      });

      if (!user) {
        return res
          .status(401)
          .json({ message: "Unauthorized: User not found" });
      }

      req.user = user;

      next();
    };

    // Only admin can access
    const verifyAdmin = (req, res, next) => {
      if (req.user?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden: Admin access only" });
      }
      next();
    };

    // Admin or Volunteer can access
    const verifyAdminOrVolunteer = (req, res, next) => {
      if (req.user?.role !== "admin" && req.user?.role !== "volunteer") {
        return res.status(403).json({ message: "Forbidden: Admin or Volunteer access only" });
      }
      next();
    };

    // Blocked users cannot mutate data
    const verifyActive = (req, res, next) => {
      if (req.user?.status === "blocked") {
        return res.status(403).json({ message: "Your account has been blocked." });
      }
      next();
    };


    // ═══════════════════════════════════════════════════════════════════════════
    // USER ROUTES
    // ═══════════════════════════════════════════════════════════════════════════

    // POST /api/users/sync
    // Called after better-auth signUp to save extra fields to your DB
    app.post("/api/users/sync", async (req, res) => {
      const { name, email, avatar, bloodGroup, district, upazila } = req.body;
      if (!email) return res.status(400).json({ message: "Email is required" });

      const existing = await usersCollection.findOne({ email });
      if (!existing) {
        await usersCollection.insertOne({
          name,
          email,
          avatar,
          bloodGroup,
          district,
          upazila,
          role: "donor",
          status: "active",
          createdAt: new Date(),
        });
      }
      res.json({ success: true });
    });

    // GET /api/users/by-email?email=xxx
    // Used by login page to check status (blocked?) and get role
    app.get("/api/users/by-email", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).json({ message: "Email required" });
      const user = await usersCollection.findOne(
        { email },
        { projection: { password: 0 } } // never expose password
      );
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    });

    // GET /api/users/:id  — get single user by MongoDB _id (for profile page)
    app.get("/api/users/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ message: "Invalid user ID" });
      const user = await usersCollection.findOne({ _id: new ObjectId(id) });
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    });

    // PATCH /api/users/profile  — update own profile (name, avatar, bloodGroup, district, upazila)
    app.patch("/api/users/profile", verifyToken, verifyActive, async (req, res) => {
      const { email } = req.user; // from JWT
      const { name, avatar, bloodGroup, district, upazila } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { name, avatar, bloodGroup, district, upazila } }
      );
      res.json({ success: true, modifiedCount: result.modifiedCount });
    });

    // GET /api/admin/users  — admin: get all users with optional status filter
    app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
      const { status } = req.query; // "active" | "blocked" | undefined (all)
      const filter = status ? { status } : {};
      const users = await usersCollection.find(filter).toArray();
      res.json(users);
    });

    // PATCH /api/admin/users/:id/status  — admin: block or unblock a user
    app.patch(
      "/api/admin/users/:id/status",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body; // "active" | "blocked"
        if (!["active", "blocked"].includes(status))
          return res.status(400).json({ message: "Invalid status value" });
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid user ID" });
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );
        res.json({ success: true, modifiedCount: result.modifiedCount });
      }
    );

    // PATCH /api/admin/users/:id/role  — admin: change user role
    app.patch(
      "/api/admin/users/:id/role",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body; // "donor" | "volunteer" | "admin"
        if (!["donor", "volunteer", "admin"].includes(role))
          return res.status(400).json({ message: "Invalid role value" });
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid user ID" });
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.json({ success: true, modifiedCount: result.modifiedCount });
      }
    );

    // GET /api/admin/stats  — admin/volunteer dashboard stats
    app.get(
      "/api/admin/stats",
      verifyToken,
      verifyAdminOrVolunteer,
      async (req, res) => {
        const [totalUsers, totalRequests, totalFunding] = await Promise.all([
          usersCollection.countDocuments({ role: "donor" }),
          donationRequestsCollection.countDocuments(),
          fundingsCollection
            .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
            .toArray(),
        ]);
        res.json({
          totalUsers,
          totalRequests,
          totalFunding: totalFunding[0]?.total || 0,
        });
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // DONATION REQUEST ROUTES
    // ═══════════════════════════════════════════════════════════════════════════

    // GET /api/donation-requests  — public: only "pending" requests
    app.get("/api/donation-requests", async (req, res) => {
      const requests = await donationRequestsCollection
        .find({ status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(requests);
    });

    // GET /api/donation-requests/:id  — public: single request details
    app.get("/api/donation-requests/:id", async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ message: "Invalid ID" });
      const request = await donationRequestsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!request) return res.status(404).json({ message: "Request not found" });
      res.json(request);
    });

    // GET /api/my-donation-requests  — donor: own requests with filter + pagination
    app.get("/api/my-donation-requests", verifyToken, async (req, res) => {
      const { email } = req.user;
      const { status, page = 1, limit = 10 } = req.query;

      const filter = { requesterEmail: email };
      if (status) filter.status = status;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const [requests, total] = await Promise.all([
        donationRequestsCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray(),
        donationRequestsCollection.countDocuments(filter),
      ]);

      res.json({ requests, total, page: parseInt(page), limit: parseInt(limit) });
    });

    // GET /api/admin/donation-requests  — admin/volunteer: ALL requests with filter + pagination
    app.get(
      "/api/admin/donation-requests",
      verifyToken,
      verifyAdminOrVolunteer,
      async (req, res) => {
        const { status, page = 1, limit = 10 } = req.query;
        const filter = status ? { status } : {};
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [requests, total] = await Promise.all([
          donationRequestsCollection
            .find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .toArray(),
          donationRequestsCollection.countDocuments(filter),
        ]);
        res.json({ requests, total, page: parseInt(page), limit: parseInt(limit) });
      }
    );

    // POST /api/donation-requests  — donor: create a new request
    app.post(
      "/api/donation-requests",
      verifyToken,
      verifyActive, // blocked users cannot create requests
      async (req, res) => {
        const {
          recipientName,
          recipientDistrict,
          recipientUpazila,
          hospitalName,
          fullAddress,
          bloodGroup,
          donationDate,
          donationTime,
          requestMessage,
        } = req.body;

        const { email } = req.user;

        // Get requester's name from DB
        const requester = await usersCollection.findOne({ email });

        const newRequest = {
          requesterName: requester?.name || "",
          requesterEmail: email,
          recipientName,
          recipientDistrict,
          recipientUpazila,
          hospitalName,
          fullAddress,
          bloodGroup,
          donationDate,
          donationTime,
          requestMessage,
          status: "pending", // always starts as pending
          donorInfo: null, // filled when someone confirms donation
          createdAt: new Date(),
        };

        const result = await donationRequestsCollection.insertOne(newRequest);
        res.status(201).json({ success: true, insertedId: result.insertedId });
      }
    );

    // PATCH /api/donation-requests/:id  — donor: edit own request fields
    app.patch(
      "/api/donation-requests/:id",
      verifyToken,
      verifyActive,
      async (req, res) => {
        const { id } = req.params;
        const { email, role } = req.user;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid ID" });

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!request) return res.status(404).json({ message: "Not found" });

        // Donors can only edit their own; admin can edit any
        if (role === "donor" && request.requesterEmail !== email) {
          return res.status(403).json({ message: "Forbidden" });
        }

        const {
          recipientName,
          recipientDistrict,
          recipientUpazila,
          hospitalName,
          fullAddress,
          bloodGroup,
          donationDate,
          donationTime,
          requestMessage,
        } = req.body;

        const result = await donationRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              recipientName,
              recipientDistrict,
              recipientUpazila,
              hospitalName,
              fullAddress,
              bloodGroup,
              donationDate,
              donationTime,
              requestMessage,
            },
          }
        );
        res.json({ success: true, modifiedCount: result.modifiedCount });
      }
    );

    // PATCH /api/donation-requests/:id/status  — update donation status
    // Donor: can change inprogress → done / inprogress → canceled (own requests only)
    // Admin: can change any status on any request
    // Volunteer: can change status only
    app.patch(
      "/api/donation-requests/:id/status",
      verifyToken,
      async (req, res) => {
        const { id } = req.params;
        const { status, donorInfo } = req.body;
        const { email, role } = req.user;

        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid ID" });

        const validStatuses = ["pending", "inprogress", "done", "canceled"];
        if (!validStatuses.includes(status))
          return res.status(400).json({ message: "Invalid status" });

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!request) return res.status(404).json({ message: "Not found" });

        // Donors: can only update their own AND only inprogress→done or inprogress→canceled
        if (role === "donor") {
          if (request.requesterEmail !== email)
            return res.status(403).json({ message: "Forbidden" });
          if (request.status !== "inprogress")
            return res.status(400).json({ message: "Can only update inprogress requests" });
          if (!["done", "canceled"].includes(status))
            return res.status(400).json({ message: "Donors can only mark done or canceled" });
        }

        const updateData = { status };
        // When a donor confirms donation (pending → inprogress), attach their info
        if (status === "inprogress" && donorInfo) {
          updateData.donorInfo = donorInfo; // { name, email }
        }

        const result = await donationRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );
        res.json({ success: true, modifiedCount: result.modifiedCount });
      }
    );

    // DELETE /api/donation-requests/:id  — donor: delete own request / admin: any
    app.delete(
      "/api/donation-requests/:id",
      verifyToken,
      verifyActive,
      async (req, res) => {
        const { id } = req.params;
        const { email, role } = req.user;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid ID" });

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!request) return res.status(404).json({ message: "Not found" });

        if (role === "donor" && request.requesterEmail !== email) {
          return res.status(403).json({ message: "Forbidden" });
        }

        await donationRequestsCollection.deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true });
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SEARCH ROUTES  (public)
    // ═══════════════════════════════════════════════════════════════════════════

    // GET /api/search/donors?bloodGroup=A+&district=Dhaka&upazila=Dhanmondi
    app.get("/api/search/donors", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const filter = { role: "donor", status: "active" };
      if (bloodGroup) filter.bloodGroup = bloodGroup;
      if (district) filter.district = district;
      if (upazila) filter.upazila = upazila;
      const donors = await usersCollection
        .find(filter, {
          projection: { name: 1, email: 1, avatar: 1, bloodGroup: 1, district: 1, upazila: 1 },
        })
        .toArray();
      res.json(donors);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNDING ROUTES
    // ═══════════════════════════════════════════════════════════════════════════

    // GET /api/fundings  — private: show all fundings
    app.get("/api/fundings", verifyToken, async (req, res) => {
      const fundings = await fundingsCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(fundings);
    });

    // POST /api/fundings  — save a completed Stripe payment record
    app.post("/api/fundings", verifyToken, verifyActive, async (req, res) => {
      const { amount, transactionId } = req.body;
      const { email } = req.user;
      const donor = await usersCollection.findOne({ email });
      const funding = {
        donorName: donor?.name || "",
        donorEmail: email,
        amount: parseFloat(amount),
        transactionId,
        createdAt: new Date(),
      };
      const result = await fundingsCollection.insertOne(funding);
      res.status(201).json({ success: true, insertedId: result.insertedId });
    });

    // POST /api/create-payment-intent  — Stripe: create payment intent
    // (install: npm install stripe)
    app.post("/api/create-payment-intent", verifyToken, verifyActive, async (req, res) => {
      const { amount } = req.body; // amount in BDT (or any currency)
      if (!amount || amount < 1)
        return res.status(400).json({ message: "Invalid amount" });
      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // convert to cents/paisa
          currency: "usd", // change to "bdt" if Stripe supports it in your region
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ─── Health check ──────────────────────────────────────────────────────────
    app.get("/", (req, res) => res.send("BloodBond API is running ✅"));

  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

run();

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));