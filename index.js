const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;

const app = express();
const cors = require('cors');

const port = process.env.PORT;
const DB = process.env.AUTH_DB_NAME;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const database = client.db(DB);
    const userCollection = database.collection('user');
    const usersCollection = database.collection('users');
    const sessionCollection = database.collection('session');
    const fundingCollection = database.collection('funding');
    const donationRequestsCollection = database.collection('donationRequests');

    //! verify token

    const verifyToken = async (req, res, next) => {
      console.log('headers', req.headers);

      const authHeader = req.headers?.authorization;
      if (!authHeader) {
        return res.status(401).json({
          message: 'Authentication required. Please log in.',
          code: 'NO_TOKEN',
        });
      }

      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).json({
          message: 'Invalid authorization format. Use Bearer token.',
          code: 'INVALID_FORMAT',
        });
      }

      const query = { token: token };
      const session = await sessionCollection.findOne(query);

      if (!session) {
        return res.status(401).send({ message: 'Invalid or expired session' }); // Add this edge case
      }

      const userId = session.userId;

      const userQuery = {
        _id: userId,
      };

      const user = await userCollection.findOne(userQuery);
      console.log('user of the session', user);

      if (!user) {
        return res.status(401).send({ message: 'User not found' }); // Add this edge case
      }

      // set data in the req object

      req.user = user;

      next();
    };

    //! verify the role

    const verifyAdmin = async (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          message: 'Authentication required before authorization check.',
          code: 'NO_USER',
        });
      }

      if (req.user.role !== 'admin') {
        return res.status(403).json({
          message:
            'Admin access required. Your current role does not have permission.',
          code: 'NOT_ADMIN',
          userRole: req.user.role, // Helpful for debugging
        });
      }
      next();
    };

    // Verify Admin OR Volunteer Role
    const verifyVolunteerOrAdmin = async (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          message: 'Authentication required before authorization check.',
          code: 'NO_USER',
        });
      }

      if (req.user.role !== 'admin' && req.user.role !== 'volunteer') {
        return res.status(403).json({
          message: 'Admin or Volunteer access required.',
          code: 'NOT_ALLOWED',
          userRole: req.user.role,
        });
      }
      next();
    };

    // 1. GET TOTAL DONOR COUNT
    //    Client calls: serverFetch("/api/users/count")
    //    Returns:      { success, count }
    // ─────────────────────────────────────────────
    app.get('/api/users/count', async (req, res) => {
      try {
        // ✅ usersCollection  (your app's "users" — NOT BetterAuth "user")
        const count = await usersCollection.countDocuments({ role: 'donor' });
        res.status(200).send({ success: true, count });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });
    // 1. GET TOTAL FUNDS (For Admin Dashboard Stats)
    app.get('/api/funding/total', verifyToken, async (req, res) => {
      try {
        const result = await fundingCollection
          .aggregate([
            { $group: { _id: null, totalAmount: { $sum: '$amount' } } },
          ])
          .toArray();

        const total = result.length > 0 ? result[0].totalAmount : 0;
        res.status(200).send({ success: true, totalAmount: total });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });
    // 3. GET TOTAL DONATION REQUEST COUNT
    app.get('/api/donation-requests/count', async (req, res) => {
      try {
        const count = await donationRequestsCollection.countDocuments();
        res.status(200).send({ success: true, count });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ! GET STATUS BREAKDOWN (For Pie Chart) - 100% Correct Grouping
    app.get('/api/donation-requests/status-breakdown', async (req, res) => {
      try {
        const results = await donationRequestsCollection
          .aggregate([
            {
              $addFields: {
                // 🟢 Step 1: Standardize "cancelled" to "canceled" BEFORE grouping
                unifiedStatus: {
                  $cond: {
                    if: {
                      $in: [
                        '$status',
                        ['canceled', 'cancelled', 'Canceled', 'Cancelled'],
                      ],
                    },
                    then: 'canceled', 
                    else: '$status',
                  },
                },
              },
            },
            {
              $group: {
                _id: '$unifiedStatus',
                value: { $sum: 1 },
              },
            },
          ])
          .toArray();

        // 🟢 Step 3: Capitalize the first letter for the Frontend
        const data = results.map(item => ({
          name: item._id.charAt(0).toUpperCase() + item._id.slice(1),
          value: item.value,
        }));

        res.status(200).send({ success: true, data });
      } catch (error) {
        console.error('🔥 Status Breakdown Error:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ─────────────────────────────────────────────
    // 5. GET WEEKLY STATS  ← Bar Chart data
    //    Client calls: serverFetch("/api/donation-requests/weekly-stats")
    //    Returns:      { success, data: [{ day, count }] }
    //    Example:      [{ day: "Mon", count: 3 }, { day: "Tue", count: 7 }]
    // ─────────────────────────────────────────────
    app.get('/api/donation-requests/weekly-stats', async (req, res) => {
      try {
        // Last 7 days window
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0); // start of that day

        const results = await donationRequestsCollection
          .aggregate([
            {
              // Only documents created in the last 7 days
              $match: {
                createdAt: { $gte: sevenDaysAgo },
              },
            },
            {
              // Group by day-of-week number (1 = Sun … 7 = Sat in MongoDB)
              $group: {
                _id: { $dayOfWeek: '$createdAt' },
                count: { $sum: 1 },
              },
            },
            {
              $sort: { _id: 1 }, // Sun → Sat order
            },
          ])
          .toArray();

        // MongoDB $dayOfWeek:  1=Sun 2=Mon 3=Tue 4=Wed 5=Thu 6=Fri 7=Sat
        const dayMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        const data = results.map(item => ({
          day: dayMap[item._id - 1], // convert 1-indexed to label
          count: item.count,
        }));

        res.status(200).send({ success: true, data });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ! Users

    app.post('/api/users', async (req, res) => {
      try {
        console.log('🔥 USER API HIT');
        console.log(req.body);
        const user = req.body;

        const existingUser = await usersCollection.findOne({
          authId: user.authId,
        });

        if (existingUser) {
          return res.status(409).send({
            success: false,
            message: 'User already exists',
          });
        }

        const result = await usersCollection.insertOne(user);

        res.status(201).send({
          success: true,
          insertedId: result.insertedId,
          message: 'User created successfully',
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });
    // ! GET HOMEPAGE STATS
    app.get('/api/stats', async (req, res) => {
      try {
        const totalDonors = await usersCollection.countDocuments({
          role: 'donor',
        });
        const totalRequests = await donationRequestsCollection.countDocuments();
        const totalFundingResult = await fundingCollection
          .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
          .toArray();
        const totalFunding = totalFundingResult[0]?.total || 0;

        res.status(200).send({
          success: true,
          totalDonors,
          totalRequests,
          totalFunding,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ! GET USER BY AUTH ID (For Profile Page)
    app.get('/api/users/:id', async (req, res) => {
      try {
        const { id } = req.params;

        const user = await usersCollection.findOne({ authId: id });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: 'User not found - authId mismatch',
          });
        }

        res.status(200).send(user);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! 3. UPDATE USER BY AUTH ID ( for profile) conflict between user vs users

    app.patch('/api/users/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const updateData = req.body;

        // Prevent sensitive field changes
        delete updateData._id;
        delete updateData.authId;
        delete updateData.email;
        delete updateData.role;
        delete updateData.status;

        // ── 1. users collection থেকে email বের করো ──
        const existingUser = await usersCollection.findOne({ authId: id });

        if (!existingUser) {
          return res
            .status(404)
            .send({ success: false, message: 'User not found' });
        }

        // ── 2. users collection update ──
        const result = await usersCollection.updateOne(
          { authId: id },
          { $set: updateData },
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: 'User not found' });
        }

        // ── 3. BetterAuth user collection sync (email দিয়ে) ──
        const authSyncData = {};
        if (updateData.name) authSyncData.name = updateData.name;
        if (updateData.image) authSyncData.image = updateData.image;

        if (Object.keys(authSyncData).length > 0) {
          authSyncData.updatedAt = new Date();
          await userCollection.updateOne(
            { email: existingUser.email },
            { $set: authSyncData },
          );
        }

        const updatedUser = await usersCollection.findOne({ authId: id });

        res.status(200).send({
          success: true,
          message: 'Profile updated successfully',
          user: updatedUser,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ! GET ALL DONATION REQUESTS (Admin & Volunteer View) WITH PAGINATION
    app.get('/api/donation-requests/all', async (req, res) => {
      try {
        const { status, page = 1, limit = 10 } = req.query;

        // 1. Build Query - Get ALL requests, optionally filter by status
        const query = {};
        if (status && status !== 'all') {
          query.status = status;
        }

        // 2. Calculate Pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // 3. Get total count
        const totalRequests =
          await donationRequestsCollection.countDocuments(query);

        // 4. Fetch paginated data (Sorted by newest first)
        const requests = await donationRequestsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        // 5. Send response with metadata
        res.status(200).send({
          success: true,
          data: requests,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalRequests / parseInt(limit)),
            totalRequests,
            limit: parseInt(limit),
          },
        });
      } catch (error) {
        console.error('🔥 Error fetching all donation requests:', error);
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! 4. CREATE DONATION REQUEST (✅ Fixed placement)

    app.post('/api/donation-requests', async (req, res) => {
      try {
        const requestData = req.body;
        console.log('Donation Request Received:', requestData);

        // 1. Validate required fields
        const requiredFields = [
          'requesterId',
          'recipientName',
          'recipientDistrict',
          'recipientUpazila',
          'hospitalName',
          'fullAddress',
          'bloodGroup',
          'donationDate',
          'donationTime',
          'requestMessage',
        ];
        for (const field of requiredFields) {
          if (!requestData[field]) {
            return res.status(400).send({
              success: false,
              message: `${field} is required`,
            });
          }
        }

        // 2. Check if the requester is blocked
        const user = await usersCollection.findOne({
          authId: requestData.requesterId,
        });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: 'Requester user not found',
          });
        }

        if (user.status === 'blocked') {
          return res.status(403).send({
            success: false,
            message:
              'Your account is blocked. You cannot create donation requests.',
          });
        }

        // 3. Construct the new request document
        const newRequest = {
          ...requestData, // ✅ This automatically includes donorName/donorEmail if they are sent
          status: requestData.status || 'pending', // ✅ Allows 'inprogress' if sent, defaults to 'pending'
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // 4. Insert into MongoDB
        const result = await donationRequestsCollection.insertOne(newRequest);

        res.status(201).send({
          success: true,
          insertedId: result.insertedId,
          message: 'Donation request created successfully',
        });
      } catch (error) {
        console.error('🔥 Donation Request Error:', error);
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! GET RECENT DONATION REQUESTS BY USER (For Donor Dashboard)

    app.get('/api/donation-requests/recent/:userId', async (req, res) => {
      try {
        const { userId } = req.params;

        // Query: Find all requests by this user, limit to 3, sort by newest first
        const requests = await donationRequestsCollection
          .find({ requesterId: userId })
          .sort({ createdAt: -1 }) // Newest first
          .limit(3) // Max 3 requests
          .toArray();

        res.status(200).send(requests);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! GET SINGLE DONATION REQUEST BY ID (For Edit Page)
    app.get('/api/donation-requests/:id', async (req, res) => {
      try {
        const { id } = req.params;

        // Validate ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: 'Invalid ID format',
          });
        }

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res.status(404).send({
            success: false,
            message: 'Request not found',
          });
        }

        res.status(200).send(request);
      } catch (error) {
        console.error('Error fetching request:', error);
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // UPDATED BACKEND CODE
    app.patch('/api/donation-requests/:id', async (req, res) => {
      try {
        const { id } = req.params; // <--- ✅ Take ID from URL
        const { status, donorName, donorEmail, userId, role } = req.body; 

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: 'Invalid ID format' });
        }

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res
            .status(404)
            .send({ success: false, message: 'Request not found' });
        }

        // ── 🟢 CORE LOGIC FIX ──

        // 1. If the status is being changed to "inprogress" (A Donor is volunteering)
        if (status === 'inprogress') {

          // ANY logged-in user can donate, EXCEPT the person who created it
          if (request.requesterId === userId) {
            return res.status(403).send({
              success: false,
              message: 'You cannot donate to your own request.',
            });
          }

          // ✅ Allow the update
          const updateFields = {
            status,
            donorName,
            donorEmail,
            updatedAt: new Date(),
          };

          await donationRequestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields },
          );

          return res.status(200).send({
            success: true,
            message:
              'Donation confirmed! You have volunteered to donate blood.',
          });
        }

        // Perform the update for Requester/Admin changing to done/canceled
        const result = await donationRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status,
              updatedAt: new Date(),
            },
          },
        );

        res.status(200).send({
          success: true,
          message: `Status updated to ${status}`,
        });
      } catch (error) {
        console.error('🔥 PATCH Error:', error);
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    //  for deleting request
    app.delete('/api/donation-requests/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { userId, role } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: 'Invalid ID format',
          });
        }

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res.status(404).send({
            success: false,
            message: 'Request not found',
          });
        }

        // Owner or Admin only
        if (request.requesterId !== userId && role !== 'admin') {
          return res.status(403).send({
            success: false,
            message: 'You are not authorized to delete this request',
          });
        }

        const result = await donationRequestsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.status(200).send({
          success: true,
          message: 'Request deleted successfully',
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! DELETE REQUEST (ADMIN ONLY) - No userId required
    app.delete(
      '/api/donation-requests/admin-delete/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body; 

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: 'Invalid ID format',
            });
          }

          // Ensure the person deleting is an admin
          if (role !== 'admin') {
            return res.status(403).send({
              success: false,
              message: 'You are not authorized to delete this request',
            });
          }

          const request = await donationRequestsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!request) {
            return res.status(404).send({
              success: false,
              message: 'Request not found',
            });
          }

          const result = await donationRequestsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          res.status(200).send({
            success: true,
            message: 'Request deleted successfully',
          });
        } catch (error) {
          console.error('🔥 Admin Delete Error:', error);
          res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    //  EDIT  donation request
    app.put(
      '/api/donation-requests/edit/:id',
      verifyToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { userId, role, ...updateData } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: 'Invalid ID format',
            });
          }

          const request = await donationRequestsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!request) {
            return res.status(404).send({
              success: false,
              message: 'Request not found',
            });
          }

          // Owner or Admin only
          if (request.requesterId !== userId && role !== 'admin') {
            return res.status(403).send({
              success: false,
              message: 'You are not authorized to edit this request',
            });
          }

          // Prevent editing if already done or canceled
          if (request.status === 'done' || request.status === 'canceled') {
            return res.status(400).send({
              success: false,
              message: `Cannot edit a request that is already ${request.status}`,
            });
          }

          const result = await donationRequestsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                ...updateData,
                updatedAt: new Date(),
              },
            },
          );

          res.status(200).send({
            success: true,
            message: 'Request updated successfully',
          });
        } catch (error) {
          console.error('Edit request error:', error);
          res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ! GET ALL DONATION REQUESTS BY USER (With Filter & Pagination)

    app.get('/api/donation-requests/my-requests/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const { status, page = 1, limit = 10 } = req.query;

        // 1. Build the MongoDB Query
        const query = { requesterId: userId };
        if (status && status !== 'all') {
          query.status = status;
        }

        // 2. Calculate Pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // 3. Get the total count (for pagination metadata)
        const totalRequests =
          await donationRequestsCollection.countDocuments(query);

        // 4. Fetch the paginated data
        const requests = await donationRequestsCollection
          .find(query)
          .sort({ createdAt: -1 }) // Newest first
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        // 5. Send response with metadata
        res.status(200).send({
          success: true,
          data: requests,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalRequests / parseInt(limit)),
            totalRequests,
            limit: parseInt(limit),
          },
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! GET ALL PENDING DONATION REQUESTS (Public Page)

    app.get('/api/donation-requests', async (req, res) => {
      try {
        const requests = await donationRequestsCollection
          .find({ status: 'pending' })
          .sort({ createdAt: -1 }) // Newest first
          .toArray();

        res.status(200).send(requests);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! GET SINGLE DONATION REQUEST BY ID (For Details Page)

    app.get(
      '/api/donation-requests/:id',
      verifyToken,

      async (req, res) => {
        try {
          const { id } = req.params;

          let objectId;
          try {
            // ✅ Wrap the ObjectId creation in a try/catch block
            objectId = new ObjectId(id);
          } catch (err) {
            // If the ID string is invalid for MongoDB, return 404 (Not Found)
            return res.status(404).send({
              success: false,
              message: 'Request not found',
            });
          }

          const request = await donationRequestsCollection.findOne({
            _id: objectId,
          });

          if (!request) {
            return res.status(404).send({
              success: false,
              message: 'Request not found',
            });
          }

          res.status(200).send(request);
        } catch (error) {
          console.error('Error fetching request:', error);
          res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ! GET DONORS BY SEARCH (Public Search Page)
    app.get('/api/donors/search', async (req, res) => {
      try {
        const { bloodGroup, district, upazila } = req.query;

        // 1. Build dynamic filter query
        const filter = {};

        if (bloodGroup && bloodGroup !== 'all') {
          filter.bloodGroup = bloodGroup;
        }

        // ⚠️ CHANGE: Search by ID instead of Name (Your users store "district": "47")
        if (district && district !== 'all') {
          filter.district = district;
        }

        // ⚠️ CHANGE: Search by ID instead of Name
        if (upazila && upazila !== 'all') {
          filter.upazila = upazila;
        }

        // 2. Only show active donors (not blocked)
        filter.status = { $ne: 'blocked' };

        console.log('🔍 Search Query:', filter);

        // 3. Query MongoDB
        const donors = await usersCollection.find(filter).limit(50).toArray();

        // 4. Return the list
        res.status(200).send({
          success: true,
          count: donors.length,
          data: donors,
        });
      } catch (error) {
        console.error('🔥 Donor Search Error:', error);
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! GET ALL USERS (Admin Only) with Pagination & Filter

    app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { status, page = 1, limit = 10 } = req.query;

        // 1. Build the MongoDB Query
        const query = {};
        if (status && status !== 'all') {
          query.status = status;
        }

        // 2. Calculate Pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // 3. Get total count
        const totalUsers = await usersCollection.countDocuments(query);

        // 4. Fetch paginated users (exclude sensitive fields like password if present)
        const users = await usersCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.status(200).send({
          success: true,
          data: users,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalUsers / parseInt(limit)),
            totalUsers,
            limit: parseInt(limit),
          },
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ! UPDATE USER STATUS / ROLE (Admin Only) - Using Better Auth API
    app.patch(
      '/api/admin/users/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params; // authId
          const { action } = req.body;

          console.log('🚀 Admin Action Received:', { authId: id, action });

          if (!action) {
            return res
              .status(400)
              .send({ success: false, message: 'Action is required' });
          }

        //  Determine the update based on the action
          let updateFields = {};

          if (action === 'block') {
            updateFields = { status: 'blocked' };
          } else if (action === 'unblock') {
            updateFields = { status: 'active' };
          } else if (action === 'makeVolunteer') {
            updateFields = { role: 'volunteer' };
          } else if (action === 'makeAdmin') {
            updateFields = { role: 'admin' };
          } else {
            return res
              .status(400)
              .send({ success: false, message: 'Invalid action provided' });
          }

          // Update the 'users' collection (Your custom app data)
          const usersUpdateResult = await usersCollection.updateOne(
            { authId: id },
            {
              $set: updateFields,
              $unset: { action: '' },
            },
          );

          if (usersUpdateResult.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "User not found in 'users' collection",
            });
          }
          console.log("✅ 'users' collection updated.");

          const appUser = await usersCollection.findOne({ authId: id });
          if (appUser) {
            await userCollection.updateOne(
              { email: appUser.email },
              { $set: updateFields },
            );
            console.log("✅ 'user' (Better Auth) collection updated.");
          } else {
            console.warn("⚠️ User not found in Better Auth 'user' collection.");
          }
          const successMessage =
            action === 'block'
              ? 'blocked'
              : action === 'unblock'
                ? 'unblocked'
                : action === 'makeVolunteer'
                  ? 'made a volunteer'
                  : 'made an admin';

          res.status(200).send({
            success: true,
            message: `User ${successMessage} successfully!`,
          });
        } catch (error) {
          console.error('🔥 Admin PATCH Error:', error);
          res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ! ==========================================
    // ! FUNDING & STRIPE ROUTES
    // ! ==========================================

    app.get('/api/funding', async (req, res) => {
      try {
        const fundingData = await fundingCollection
          .aggregate([
            {
              $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: 'authId',
                as: 'donorInfo',
              },
            },
            {
              $unwind: { path: '$donorInfo', preserveNullAndEmptyArrays: true },
            },
            {
              $project: {
                donorName: '$donorInfo.name',
                donorEmail: '$donorInfo.email',
                amount: 1,
                createdAt: 1,
                paymentId: 1,
              },
            },
            { $sort: { createdAt: -1 } },
          ])
          .toArray();

        res.status(200).send({ success: true, data: fundingData });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // 3. CREATE STRIPE PAYMENT INTENT
    app.post('/api/funding/create-payment-intent', async (req, res) => {
      try {
        const { amount } = req.body; // Amount is in cents

        const paymentIntent = await stripe.paymentIntents.create({
          amount: parseInt(amount),
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error('🔥 Stripe Error:', error);
        res.status(500).send({ error: error.message });
      }
    });

    // 4. SAVE FUNDING TO DATABASE
    app.post('/api/funding', async (req, res) => {
      try {
        const { userId, amount, paymentId } = req.body;

        if (!userId || !amount || !paymentId) {
          return res
            .status(400)
            .send({ success: false, message: 'Missing required fields' });
        }

        const newFunding = {
          userId: userId,
          amount: parseFloat(amount),
          paymentId: paymentId,
          createdAt: new Date(),
        };

        await fundingCollection.insertOne(newFunding);

        res.status(201).send({
          success: true,
          message: 'Funding saved successfully!',
        });
      } catch (error) {
        console.error('🔥 Funding Save Error:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!',
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
